// Regression tests for Issue #66: timed-out agent sessions stop their whole process tree, the timeout is an explicit
// flag, and arguments with spaces and quotes reach the agent unchanged. Only harmless local Node processes are started
// (no Codex). On Windows the agent is launched through a copy of npm's codex.cmd shim, as in a real run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { killProcessTree, quoteWindowsArgument, spawnPlan, startProcess } from "./process.mjs";

const IS_WIN = process.platform === "win32";

const FIXTURE = [
  "import { spawn } from \"node:child_process\";",
  "import fs from \"node:fs\";",
  "const [mode, ...rest] = process.argv.slice(2);",
  "if (mode === \"args\") process.stdout.write(JSON.stringify(rest));",
  "else if (mode === \"stderr-timeout\") process.stderr.write(\"TIMEOUT while reading a fixture (not a real timeout)\\n\");",
  "else if (mode === \"tree\") {",
  "  const child = spawn(process.execPath, [process.argv[1], \"sleep\"], { stdio: [\"ignore\", \"inherit\", \"inherit\"] });",
  "  fs.writeFileSync(rest[0] + \".tmp\", JSON.stringify({ parent: process.pid, grandchild: child.pid }));",
  "  fs.renameSync(rest[0] + \".tmp\", rest[0]);",
  "  setInterval(() => {}, 1000);",
  "} else if (mode === \"sleep\") setInterval(() => {}, 1000);",
  "",
].join("\n");

// npm's cmd-shim for a global package (the codex.cmd that "codex" resolves to on Windows), pointed at the fixture.
const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\agent-fixture.mjs\" %*", "",
].join("\r\n");

let dir = "";
let env = {};
let counter = 0;
const tracked = new Set();

// Running, not merely present: on POSIX an ended process whose parent also ended stays a zombie (state Z) until init
// reaps it, and kill(pid, 0) still succeeds for it. A zombie has exited and holds no stdio, so it counts as ended.
function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code !== "EPERM") return false; }
  if (IS_WIN) return true;
  let state;
  try { state = fs.readFileSync("/proc/" + pid + "/stat", "utf8").replace(/^.*\)\s+/su, "").charAt(0); }
  catch {
    const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    if (ps.error !== undefined) return true; // cannot tell: treat as running, never as ended
    state = ps.stdout.trim().charAt(0);
  }
  return state !== "" && state !== "Z";
}
async function waitFor(read, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting for the fixture");
    await new Promise((r) => setTimeout(r, 25));
  }
}
function readPids(file) {
  try {
    const pids = JSON.parse(fs.readFileSync(file, "utf8"));
    tracked.add(pids.parent); tracked.add(pids.grandchild);
    return pids;
  } catch { return undefined; }
}
function collect(stream) { let s = ""; stream.setEncoding("utf8"); stream.on("data", (d) => { s += d; }); return () => s; }
const pidFile = () => path.join(dir, "pids-" + ++counter + ".json");

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv proc 66 "));
  fs.writeFileSync(path.join(dir, "agent-fixture.mjs"), FIXTURE);
  if (IS_WIN) fs.writeFileSync(path.join(dir, "fake-agent.cmd"), NPM_SHIM);
  else {
    fs.writeFileSync(path.join(dir, "fake-agent"), "#!/bin/sh\n\"" + process.execPath + "\" \"" + dir + "/agent-fixture.mjs\" \"$@\"\n");
    fs.chmodSync(path.join(dir, "fake-agent"), 0o755);
  }
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"));
  env.PATH = [dir, path.dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ""].join(path.delimiter);
});

afterEach(() => {
  for (const pid of tracked) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  tracked.clear();
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe("Value Validation agent process control (#66)", () => {
  it("a normal exit is not a timeout", { timeout: 60_000 }, async () => {
    const { child, result } = startProcess("fake-agent", ["args", "ok"], { env, cwd: dir, timeoutMs: 30_000 });
    const out = collect(child.stdout);
    const r = await result;
    expect(r).toMatchObject({ exit: 0, timedOut: false, terminated: null });
    expect(r.killAttempts).toBeUndefined();
    expect(JSON.parse(out())).toEqual(["ok"]);
  });

  it("a timeout stops the agent and its descendants before the result resolves", { timeout: 60_000 }, async () => {
    const file = pidFile();
    const { result } = startProcess("fake-agent", ["tree", file], { env, cwd: dir, timeoutMs: 4_000 });
    const pids = await waitFor(() => readPids(file));
    expect(alive(pids.parent) && alive(pids.grandchild)).toBe(true);
    const r = await result;
    expect(r).toMatchObject({ timedOut: true, terminated: true });
    expect(r.killAttempts[0]).toMatchObject({ ok: true });
    // Checked at once, without waiting: the session has ended, so the next run cannot overlap it.
    expect(alive(pids.parent)).toBe(false);
    expect(alive(pids.grandchild)).toBe(false);
    const next = startProcess("fake-agent", ["args", "next run"], { env, cwd: dir, timeoutMs: 30_000 });
    const out = collect(next.child.stdout);
    expect(await next.result).toMatchObject({ exit: 0, timedOut: false });
    expect(JSON.parse(out())).toEqual(["next run"]);
    expect(alive(pids.grandchild)).toBe(false);
  });

  it("a tree that does not stop is reported as terminated: false, not as success", { timeout: 60_000 }, async () => {
    const file = pidFile();
    const failing = () => ({ ok: false, error: "simulated taskkill failure" });
    const { child, result } = startProcess("fake-agent", ["tree", file], { env, cwd: dir, timeoutMs: 3_000, closeDeadlineMs: 1_500, killTree: failing });
    const pids = await waitFor(() => readPids(file));
    const r = await result;
    expect(r).toMatchObject({ timedOut: true, terminated: false });
    expect(r.killAttempts[0]).toEqual({ ok: false, error: "simulated taskkill failure" });
    expect(alive(pids.grandchild)).toBe(true);
    // The real tree kill still works on the same root.
    expect(killProcessTree(child, "SIGKILL")).toMatchObject({ ok: true });
    await waitFor(() => (alive(pids.parent) || alive(pids.grandchild) ? undefined : true));
  });

  it("terminating a process that already exited is a no-op", { timeout: 60_000 }, async () => {
    let calls = 0;
    const spy = (child, signal) => { calls++; return killProcessTree(child, signal); };
    const done = startProcess("fake-agent", ["args"], { env, cwd: dir, killTree: spy });
    await done.result;
    expect(done.terminate()).toEqual({ ok: true, skipped: "already-exited" });
    expect(done.terminate()).toEqual({ ok: true, skipped: "already-exited" });
    expect(calls).toBe(0);
    // A finished Windows root is never signalled by PID, because the PID may already belong to another process.
    expect(killProcessTree(done.child)).toMatchObject(IS_WIN ? { ok: false, skipped: "root-exited" } : { ok: true });

    const file = pidFile();
    const timed = startProcess("fake-agent", ["tree", file], { env, cwd: dir, timeoutMs: 3_000, killTree: spy });
    await waitFor(() => readPids(file));
    expect(await timed.result).toMatchObject({ timedOut: true, terminated: true });
    const after = calls;
    expect(timed.terminate()).toEqual({ ok: true, skipped: "already-exited" });
    expect(calls).toBe(after);
  });

  it("TIMEOUT in stderr is not a timeout", { timeout: 60_000 }, async () => {
    const { child, result } = startProcess("fake-agent", ["stderr-timeout"], { env, cwd: dir, timeoutMs: 30_000 });
    const err = collect(child.stderr);
    expect(await result).toMatchObject({ exit: 0, timedOut: false, terminated: null });
    expect(err()).toContain("TIMEOUT");
  });

  it("paths, -c arguments, quotes and cmd metacharacters reach the agent unchanged", { timeout: 60_000 }, async () => {
    const repo = path.join(dir, "repo with space");
    const args = [
      "-C", repo, "-c", "approval_policy=\"never\"", "-c", "projects.\"" + repo.replaceAll("\\", "\\\\") + "\".trust_level=\"trusted\"",
      "two words", "", "trailing\\", "x & echo INJECTED", "100%", "%PATH%", "^caret", "a|b<c>d", "quote\"inside", "back\\\\\"slash", "(paren)!",
    ];
    for (const command of ["fake-agent", process.execPath]) {
      const full = command === process.execPath ? [path.join(dir, "agent-fixture.mjs"), "args", ...args] : ["args", ...args];
      const { child, result } = startProcess(command, full, { env, cwd: dir, timeoutMs: 30_000 });
      const out = collect(child.stdout);
      expect(await result).toMatchObject({ exit: 0, timedOut: false });
      expect(JSON.parse(out())).toEqual(args);
    }
  });

  it("a command that cannot be started is reported, not timed out", { timeout: 60_000 }, async () => {
    const r = await startProcess("vv-no-such-agent-66", [], { env, cwd: dir, timeoutMs: 30_000 }).result;
    expect(r.spawnError).toMatch(/ENOENT/u);
    expect(r).toMatchObject({ timedOut: false, terminated: null });
  });

  it("plans a shell-free launch, wrapping only .cmd shims in cmd.exe", () => {
    expect(quoteWindowsArgument("")).toBe("\"\"");
    expect(quoteWindowsArgument("a b")).toBe("\"a b\"");
    expect(quoteWindowsArgument("a\\\"b")).toBe("\"a\\\\\\\"b\"");
    expect(quoteWindowsArgument("end\\")).toBe("\"end\\\\\"");
    const plan = spawnPlan("fake-agent", ["x"], { env, cwd: dir });
    if (IS_WIN) {
      expect(plan.file.toLowerCase()).toMatch(/system32\\cmd\.exe$/u);
      expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(plan.options).toEqual({ windowsVerbatimArguments: true });
      expect(spawnPlan(process.execPath, [], { env, cwd: dir })).toMatchObject({ file: process.execPath, options: {} });
    } else {
      expect(plan).toEqual({ file: "fake-agent", args: ["x"], options: { detached: true } });
    }
  });
});

