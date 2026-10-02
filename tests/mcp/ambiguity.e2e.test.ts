/**
 * T26.2 agent-facing ambiguity remediation. When duo_get_context cannot choose between targets, the text an agent reads
 * says how to retry, and only with a handle the seed resolver accepts (a repository-relative path with a /, a qualified
 * name, a Requirement or Decision ID). The resolver, the candidates and the structured payload are unchanged:
 * structuredContent stays equal to the CLI --json result. Runs against the built duoctl and, in pnpm test:conformance,
 * against the installed package.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { duoctl } from "../cli/support.js";
import { startMcp, type McpSession } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const CANARY = "AKIADUOAMBIGUITYCAN1";
let root = "";
let mcp: McpSession;

const REQS = "# Export\n\n## TIE-01 Zephyr quokka export\n\n```duo\nstatus: planned\npriority: should\n```\n\nZephyr quokka export of the ledger.\n\n## TIE-02 Zephyr quokka export\n\n```duo\nstatus: planned\npriority: should\n```\n\nZephyr quokka export of the ledger.\n";

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-ambiguity-")));
  fs.cpSync(path.join(REPO, "fixtures", "context", "app"), root, { recursive: true });
  // Same file, different qualified names: a path does not tell them apart, a qualified name does.
  fs.writeFileSync(path.join(root, "src", "shapes.ts"), "export class Circle {\n  area(): number { return 1; }\n}\n\nexport class Square {\n  area(): number { return 2; }\n}\n");
  // Neither one path nor one qualified name tells all three apart.
  fs.mkdirSync(path.join(root, "src", "jobs"));
  fs.writeFileSync(path.join(root, "src", "jobs", "a.ts"), "export class Worker {\n  launch(): void {}\n}\n\nexport class Pool {\n  launch(): void {}\n}\n");
  fs.writeFileSync(path.join(root, "src", "jobs", "b.ts"), "export class Worker {\n  launch(): void {}\n}\n");
  // Two Requirements that tie on keywords.
  fs.writeFileSync(path.join(root, ".duo-project", "specs", "export.md"), REQS);
  const git = (...a: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...a], { cwd: root, env: gitEnv, windowsHide: true, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  expect(duoctl(root, ["index", "--json"]).code).toBe(0);
  mcp = await startMcp(root);
});
afterAll(async () => {
  await mcp?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const context = async (task: string) => {
  const r = await mcp.call("duo_get_context", { task });
  expect(r.isError).not.toBe(true);
  return { text: r.content.map((c) => c.text ?? "").join("\n"), structured: r.structuredContent };
};
const cliHuman = (task: string, locale = "en") => { const r = duoctl(root, ["context", task, "--locale", locale]); return r.stdout + r.stderr; };
const cliJson = (task: string) => duoctl(root, ["context", task, "--json"]).json().result;

describe("duo_get_context ambiguity remediation (T26.2)", () => {
  it("A: targets in different files: retry with a repository-relative path, which does make the context proceed", async () => {
    const c = await context("fix normalize");
    expect(c.structured.status).toBe("ambiguous");
    expect(c.structured.context.resolution.ambiguities[0]).toMatchObject({ term: "normalize", reason: "symbol-name" });
    expect(c.text).toMatch(/AMBIGUOUS: "normalize" matches several targets\. Retry duo_get_context with one target's repository-relative file path/u);
    expect(c.text).toMatch(/Do not guess/u);
    expect(cliHuman("fix normalize")).toMatch(/repository-relative file path/u);
    expect((await context("fix normalize src/util/text.ts")).structured.status).not.toBe("ambiguous");
  });

  it("B: targets in the same file: retry with a qualified name, no promise that a path tells them apart", async () => {
    const c = await context("tune area");
    expect(c.structured.status).toBe("ambiguous");
    expect(c.text).toMatch(/Retry duo_get_context with one target's qualified name/u);
    expect(c.text).toMatch(/A file path does not tell these targets apart/u);
    expect(c.text).not.toMatch(/repository-relative file path/u);
    const human = cliHuman("tune area");
    expect(human).toMatch(/qualified name/u);
    expect(human).not.toMatch(/repository-relative file path/u);
    expect((await context("tune Circle.area")).structured.status).not.toBe("ambiguous");
  });

  it("C: Requirements that tie: retry with one Requirement ID, which makes the context proceed; an ID also unblocks a symbol ambiguity", async () => {
    const c = await context("zephyr quokka");
    expect(c.structured.status).toBe("ambiguous");
    expect(c.structured.context.resolution.ambiguities[0]).toMatchObject({ reason: "keyword-tie" });
    expect(c.text).toMatch(/Retry duo_get_context with one Requirement ID \(as listed in context\.resolution\.ambiguities\)/u);
    expect(cliHuman("zephyr quokka")).toMatch(/Requirement ID/u);
    expect((await context("zephyr quokka TIE-01")).structured.status).not.toBe("ambiguous");
    expect((await context("fix normalize")).text).toMatch(/If the task is about a specific Requirement or Decision, its ID is also an exact starting point/u);
    expect((await context("fix normalize AUTH-03")).structured.status).not.toBe("ambiguous");
  });

  it("D: a Decision ID in the task also makes the context proceed", async () => {
    expect((await context("tune area")).text).toMatch(/Requirement or Decision/u);
    expect((await context("tune area D-015")).structured.status).not.toBe("ambiguous");
  });

  it("E: no single path or name tells the targets apart: ask the human, no retry handle is promised", async () => {
    const c = await context("start launch");
    expect(c.structured.status).toBe("ambiguous");
    expect(c.text).toMatch(/No single file path or name tells these targets apart\. Ask the human which one is meant/u);
    expect(c.text).not.toMatch(/Retry duo_get_context/u);
    expect(c.text).not.toMatch(/exact starting point/u);
    expect(cliHuman("start launch")).toMatch(/no single file path or name/iu);
  });

  it("the structured result is the CLI --json result and keeps its shape; a non-ambiguous task reads as before", async () => {
    for (const task of ["fix normalize", "tune area", "zephyr quokka", "start launch", "AUTH-03"]) {
      const c = await context(task);
      expect(c.structured, task).toEqual(cliJson(task));
      expect(Object.keys(c.structured).sort(), task).toEqual(["context", "format", "gaps", "status"]);
    }
    const plain = await context("AUTH-03");
    expect(plain.structured.status).toBe("ready");
    expect(plain.text).not.toMatch(/AMBIGUOUS|Retry duo_get_context/u);
    expect(cliHuman("AUTH-03")).not.toMatch(/qualified name|repository-relative file path/u);
  });

  it("ko CLI wording names the same handle; no local path, home directory or credential-shaped text in the remediation", async () => {
    expect(cliHuman("fix normalize", "ko")).toMatch(/저장소 상대 파일 경로/u);
    expect(cliHuman("tune area", "ko")).toMatch(/qualified name/u);
    expect(cliHuman("start launch", "ko")).toMatch(/직접 정해/u);
    const c = await context("fix normalize " + CANARY);
    expect(c.structured.status).toBe("ambiguous");
    for (const t of [c.text, cliHuman("fix normalize " + CANARY)]) {
      expect(t).not.toContain(CANARY);
      expect(t).not.toContain(root);
      expect(t).not.toContain(os.homedir());
    }
  });

  it("the MCP server process ends when the client closes (no leaked process)", async () => {
    const pid = mcp.pid;
    expect(pid).not.toBeNull();
    await mcp.close();
    const alive = () => { try { process.kill(pid as number, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  });
});
