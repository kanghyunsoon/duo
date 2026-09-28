import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { resolveMcpRoot } from "./root.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe("duoctl mcp root resolution (T17)", () => {
  it("git-cwd finds the work tree top level from a subdirectory; env:NAME reads an absolute path; nothing else is accepted", async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-root-")));
    temps.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
    fs.mkdirSync(path.join(repo, "a", "b"), { recursive: true });
    const sub = path.join(repo, "a", "b");
    expect((await resolveMcpRoot({ rootFrom: "git-cwd" }, { cwd: sub, env: {} })).value).toBe(path.resolve(repo));
    expect((await resolveMcpRoot({ rootFrom: "env:CLAUDE_PROJECT_DIR" }, { cwd: sub, env: { CLAUDE_PROJECT_DIR: repo } })).value).toBe(path.resolve(repo));
    expect(codes(await resolveMcpRoot({ rootFrom: "env:CLAUDE_PROJECT_DIR" }, { cwd: sub, env: {} }))).toEqual(["MCP_ROOT_UNRESOLVED"]);
    expect(codes(await resolveMcpRoot({ rootFrom: "env:CLAUDE_PROJECT_DIR" }, { cwd: sub, env: { CLAUDE_PROJECT_DIR: "relative/dir" } }))).toEqual(["MCP_ROOT_UNRESOLVED"]);
    expect(codes(await resolveMcpRoot({ rootFrom: "shell:$(pwd)" }, { cwd: sub, env: {} }))).toEqual(["CLI_USAGE_INVALID"]);
    expect(codes(await resolveMcpRoot({ root: ".", rootFrom: "git-cwd" }, { cwd: sub, env: {} }))).toEqual(["CLI_USAGE_INVALID"]);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-nogit-")));
    temps.push(outside);
    expect(codes(await resolveMcpRoot({ rootFrom: "git-cwd" }, { cwd: outside, env: {} }))).toEqual(["MCP_ROOT_UNRESOLVED"]);
    expect((await resolveMcpRoot({ root: "x" }, { cwd: repo, env: {} })).value).toBe(path.join(repo, "x"));
  });
});
