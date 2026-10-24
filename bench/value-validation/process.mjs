// Process control for the Value Validation harnesses (Issue #66): start an agent CLI without shell-quoting errors and,
// on a timeout, stop the whole process tree that this harness started, then confirm it ended before the next run.
//
// Windows: the command is resolved like cmd.exe does (PATH x PATHEXT). An .exe/.com runs directly. A .cmd/.bat shim (npm's
// codex.cmd) runs through "cmd.exe /d /s /c" with every argument quoted for CreateProcess and escaped for cmd twice,
// because the shim hands its arguments to cmd again through %*. A timeout runs "taskkill /PID <root> /T /F" on the root
// process this harness spawned, and only while that root is still running (a finished PID can be reused).
// POSIX: the child is a process-group leader (detached); a timeout sends SIGTERM to that group, then SIGKILL after a grace
// period. A group ID is not reused while any member is alive.
// The session ends when the child's stdio closes. Descendants inherit stdio, so "close" means the tree is gone. If it
// does not close within the deadline the result says terminated: false, and the caller must stop instead of starting the
// next run.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const SYSTEM32 = path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");
const TASKKILL = path.join(SYSTEM32, "taskkill.exe");
const CMD = path.join(SYSTEM32, "cmd.exe");
const CMD_META = /([()\][%!^"\x60<>&|;, *?])/gu;

function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(f) {
  try { return fs.statSync(f).isFile(); } catch { return false; }
}

/** Resolves a command like cmd.exe: a name without an extension is tried with each PATHEXT extension in each PATH entry. */
export function resolveWindowsCommand(command, { env = process.env, cwd = process.cwd() } = {}) {
  const exts = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = path.isAbsolute(command) || /[\\/]/u.test(command) ? [""] : (envValue(env, "PATH") ?? "").split(";").filter(Boolean);
  const suffixes = exts.some((e) => e.toLowerCase() === path.extname(command).toLowerCase()) ? [""] : exts;
  for (const dir of dirs) for (const ext of suffixes) {
    const f = path.resolve(cwd, dir, command + ext);
    if (isFile(f)) return f;
  }
  return undefined;
}

/** Quotes one argument for the MSVC/CreateProcess command-line rules (backslashes before a quote are doubled). */
export function quoteWindowsArgument(arg) {
  let out = "\"";
  let backslashes = 0;
  for (const ch of String(arg)) {
    if (ch === "\\") { backslashes++; continue; }
    out += ch === "\"" ? "\\".repeat(backslashes * 2 + 1) + "\"" : "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + "\"";
}

const caretEscape = (s) => s.replace(CMD_META, "^$1");

/** How to spawn command + args on this platform without a shell parsing unescaped arguments. */
export function spawnPlan(command, args, { env = process.env, cwd = process.cwd() } = {}) {
  if (!IS_WIN) return { file: command, args: [...args], options: { detached: true } };
  const resolved = resolveWindowsCommand(command, { env, cwd });
  if (resolved === undefined) return { file: command, args: [...args], options: {} }; // spawn reports ENOENT
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file: resolved, args: [...args], options: {} };
  if (ext !== ".cmd" && ext !== ".bat") throw new Error("cannot run " + resolved + ": only .exe, .com, .cmd and .bat are supported");
  const line = [caretEscape(resolved), ...args.map((x) => caretEscape(caretEscape(quoteWindowsArgument(x))))].join(" ");
  return { file: CMD, args: ["/d", "/s", "/c", "\"" + line + "\""], options: { windowsVerbatimArguments: true } };
}

/** Signals the process tree rooted at this harness's own child. Never called with another PID. */
export function killProcessTree(child, signal = "SIGTERM") {
  if (child.pid === undefined) return { ok: true, skipped: "not-spawned" };
  if (IS_WIN) {
    if (child.exitCode !== null || child.signalCode !== null) return { ok: false, skipped: "root-exited", error: "the root process has exited; its PID is not signalled because it may be reused" };
    const r = spawnSync(TASKKILL, ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (r.status === 0) return { ok: true };
    return { ok: false, error: "taskkill exited " + r.status + ": " + String(r.stderr || r.stdout || r.error?.message || "").trim() };
  }
  try { process.kill(-child.pid, signal); return { ok: true }; }
  catch (error) { return error.code === "ESRCH" ? { ok: true, skipped: "group-gone" } : { ok: false, error: String(error.message ?? error) }; }
}

const active = new Set();
/** On POSIX the child has its own process group, so Ctrl+C on the harness no longer reaches it; stop it explicitly. */
export function installSignalCleanup() {
  if (IS_WIN) return;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => {
    for (const child of active) killProcessTree(child, "SIGKILL");
    process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
  });
}

/**
 * Starts command + args. result resolves after the child's stdio has closed, or after closeDeadlineMs past a timeout:
 * { exit, signal, timedOut, terminated, killAttempts, wallMs, pid, spawnError? }. timedOut is set by the timer only.
 * terminated is null without a timeout, true when the tree ended after it, false when it did not end in time.
 */
export function startProcess(command, args, { cwd, env = process.env, input, timeoutMs, killGraceMs = 5_000, closeDeadlineMs = 20_000, killTree = killProcessTree } = {}) {
  const plan = spawnPlan(command, args, { env, cwd });
  const t0 = performance.now();
  const child = spawn(plan.file, plan.args, { cwd, env, windowsHide: true, ...plan.options });
  active.add(child);
  child.stdin?.on("error", () => {}); // the child may exit before reading its input
  let timedOut = false;
  let stopping = false;
  let settled = false;
  let spawnError;
  const killAttempts = [];
  const timers = [];
  let settle;
  const result = new Promise((resolve) => {
    settle = (closed, code = child.exitCode, sig = child.signalCode) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      active.delete(child);
      if (!closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
      resolve({
        exit: code, signal: sig, timedOut, terminated: stopping ? closed : null, wallMs: Math.round(performance.now() - t0), pid: child.pid ?? null,
        ...(killAttempts.length === 0 ? {} : { killAttempts }), ...(spawnError === undefined ? {} : { spawnError: String(spawnError.message ?? spawnError) }),
      });
    };
  });
  child.once("error", (error) => { spawnError ??= error; if (child.pid === undefined) settle(true, null, null); });
  child.once("close", (code, sig) => settle(true, code, sig));
  const stop = () => {
    if (settled) return { ok: true, skipped: "already-exited" };
    if (stopping) return { ok: true, skipped: "already-stopping" };
    stopping = true;
    const first = killTree(child, "SIGTERM");
    killAttempts.push(first);
    if (!IS_WIN) timers.push(setTimeout(() => { if (!settled) killAttempts.push(killTree(child, "SIGKILL")); }, killGraceMs));
    timers.push(setTimeout(() => settle(false), closeDeadlineMs));
    return first;
  };
  if (timeoutMs !== undefined) timers.push(setTimeout(() => { if (!settled) { timedOut = true; stop(); } }, timeoutMs));
  if (input !== undefined) child.stdin?.end(input);
  return { child, result, terminate: stop };
}

