/**
 * H-104 (#165) end to end: the CLI and the MCP server refuse new input with unsupported glob syntax, and a Decision
 * already confirmed with such a pattern is reported by status, doctor, MCP duo_get_status and review. Its file stays
 * byte-for-byte the same, a supported rule keeps blocking, and the verdict comes from the other rules.
 */
import fs from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDecisionService } from "@duo-director/core";
import { run, type Io } from "../../apps/cli/src/cli.js";
import { startMcp, type McpSession } from "../mcp/support.js";
import { duoctl, existingProject } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
const sessions: McpSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed CLI and MCP JSON
type Json = any;
const BRACE = "src/assets/**/*.{png,webp}";
const EXTGLOB = "src/assets/**/*.@(png|webp)";
const decision = (id: string, pattern: string) => [
  `id: ${id}`, "title: No raw assets", "kind: decision", "state: confirmed", "question: assets", "answer: none", "owner: human",
  "forbids:", `  paths: [${JSON.stringify(pattern)}]`, "enforcement: block", 'confirmed_at: "2026-11-04T00:00:00Z"', "confirmed_by: Ada Lovelace", "",
].join("\n");

describe("H-104: unsupported glob syntax in Decision patterns", () => {
  const p = existingProject(temps);
  const D001 = ".duo-project/decisions/D-001.yaml";
  let d001: string;

  it("MCP duo_propose_decision refuses a brace pattern with PROPOSAL_INVALID and writes nothing", async () => {
    const answers = [{ question: "project_goal", value: "Keep recurring chores fair." }];
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify(answers)).code).toBe(0);
    p.git("add", "-A");
    p.git("commit", "-qm", "adopt DUO");
    const s = await startMcp(p.root);
    sessions.push(s);
    const r = await s.call("duo_propose_decision", { title: "No raw assets", question: "assets", answer: "none", forbids: { paths: [BRACE] }, enforcement: "block" });
    expect(r.isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toContain("PROPOSAL_INVALID");
    expect(text).toContain(`forbids.paths pattern \\"${BRACE}\\"`);
    expect(fs.existsSync(`${p.root}/.duo-project/decisions/proposals`) ? fs.readdirSync(`${p.root}/.duo-project/decisions/proposals`) : []).toEqual([]);
    // #167 review: an extglob group is refused the same way.
    const ext = await s.call("duo_propose_decision", { title: "No raw assets", question: "assets", answer: "none", forbids: { paths: [EXTGLOB] }, enforcement: "block" });
    expect(ext.isError).toBe(true);
    expect(JSON.stringify(ext)).toContain("PROPOSAL_INVALID");
    expect(JSON.stringify(ext)).toContain(`forbids.paths pattern \\"${EXTGLOB}\\"`);
    const ok = await s.call("duo_propose_decision", { title: "No route", question: "routes", answer: "none", forbids: { paths: ["app/[id]/page.tsx"] } });
    expect(ok.isError).toBeFalsy();
    // Parentheses alone are literal path characters (Next.js route groups).
    const group = await s.call("duo_propose_decision", { title: "No marketing page", question: "marketing", answer: "none", forbids: { paths: ["app/(marketing)/page.tsx"] } });
    expect(group.isError).toBeFalsy();
    fs.rmSync(`${p.root}/.duo-project/decisions/proposals`, { recursive: true, force: true });
  });

  it("CLI decision confirm refuses a pending proposal with an extglob pattern and writes no Decision (#167 review)", async () => {
    const proposed = await createDecisionService({ root: p.root }).propose({ kind: "agent", name: "codex" }, { title: "No raw assets", question: "assets", answer: "none", forbids: { paths: ["src/assets/**/*.png"] }, enforcement: "block" });
    const id = proposed.value?.proposalId ?? "";
    const file = `${p.root}/${proposed.value?.path ?? ""}`;
    // A proposal written before this check (an older DUO) can still hold the pattern.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- src/assets/**/*.png", "- " + JSON.stringify(EXTGLOB)));
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      out: (l) => out.push(l), err: (l) => err.push(l), isTTY: true, prompt: () => Promise.resolve(id),
      readStdin: () => Promise.resolve(""), cwd: () => p.root, now: () => new Date("2026-11-05T00:00:00Z"), env: {},
    };
    expect(await run(["decision", "confirm", id], io)).toBe(1);
    expect(err.join("\n")).toContain("PATTERN_SYNTAX_UNSUPPORTED");
    expect(err.join("\n")).toContain(`forbids.paths pattern "${EXTGLOB}"`);
    expect(fs.existsSync(`${p.root}/.duo-project/decisions/D-001.yaml`)).toBe(false);
    fs.rmSync(`${p.root}/.duo-project/decisions/proposals`, { recursive: true, force: true });
  });

  it("a confirmed Decision with a brace pattern loads; status, doctor and MCP status name it", async () => {
    p.write(D001, decision("D-001", BRACE));
    p.write(".duo-project/decisions/D-002.yaml", decision("D-002", "src/assets/**/*.png"));
    p.git("add", "-A");
    p.git("commit", "-qm", "decisions");
    d001 = p.read(D001);
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    const expected = [{ decision: "D-001", field: "forbids.paths", pattern: BRACE, reason: expect.stringContaining("braces") }];
    const status = duoctl(p.root, ["status", "--json"]);
    expect(status.code).toBe(0);
    expect(status.json().result.truth).toMatchObject({ decisions: 2, errors: [], unsupportedPatterns: expected });
    expect(duoctl(p.root, ["status"]).stdout).toContain(`Decision patterns with unsupported syntax: D-001 forbids.paths "${BRACE}"`);

    const doctor = duoctl(p.root, ["doctor", "--json"]);
    const checks = doctor.json().result.checks as Json[];
    expect(checks.find((c) => c.id === "truth.project")).toMatchObject({
      status: "warning", reason: "unsupported-patterns", facts: { decisions: 2, unsupportedPatterns: expected },
      actions: [{ id: "supersede-decision", commands: [], params: { ids: "D-001" } }],
    });
    // A warning, not an error: the checks that need Project Truth still run.
    expect(checks.find((c) => c.id === "index.freshness")?.status).not.toBe("skipped");
    const human = duoctl(p.root, ["doctor"]);
    expect(human.code).toBe(doctor.code);
    expect(human.stdout).toContain(`Decision patterns with unsupported syntax (unsupported syntax; legacy matching retained): D-001 forbids.paths "${BRACE}"`);
    expect(human.stdout).toContain("supersedes D-001 with supported patterns");

    const s = await startMcp(p.root);
    sessions.push(s);
    const mcp = await s.call("duo_get_status");
    expect(JSON.stringify(mcp.content)).toContain(`Decision patterns with unsupported syntax: D-001 forbids.paths \\"${BRACE}\\"`);
  });

  it("review: the supported rule still blocks, the brace rule is a limitation, and its file is unchanged", () => {
    p.write("src/assets/a.png", "x");
    p.write("src/assets/b.webp", "x");
    const r = duoctl(p.root, ["review", "--refresh", "--json"]).json().result as Json;
    expect(r.verdict).toBe("BLOCK");
    expect(r.claims.filter((c: Json) => c.rule === "decision-forbids").map((c: Json) => c.subject.id)).toEqual(["D-002"]);
    expect(r.limitations).toContainEqual({ code: "decision-patterns-unsupported", message: expect.stringContaining(`D-001 forbids.paths "${BRACE}"`) });
    fs.rmSync(`${p.root}/src/assets/a.png`);
    const webpOnly = duoctl(p.root, ["review", "--refresh", "--json"]).json().result as Json;
    expect(webpOnly.verdict).toBe("PASS");
    expect(webpOnly.limitations.map((l: Json) => l.code)).toContain("decision-patterns-unsupported");
    const human = duoctl(p.root, ["review"]);
    expect(human.stdout).toContain("decision-patterns-unsupported");
    expect(human.stdout).toContain(`D-001 forbids.paths "${BRACE}": confirmed Decision patterns with unsupported syntax`);
    expect(p.read(D001)).toBe(d001);
  });

  it("a legacy ** inside a segment keeps blocking direct children, without claiming the rule was not checked", () => {
    p.write(".duo-project/decisions/D-003.yaml", decision("D-003", "src/**.ts"));
    p.edit("src/scheduler.ts", "% 7", "% 5");
    const r = duoctl(p.root, ["review", "--refresh", "--json"]).json().result as Json;
    expect(r.verdict).toBe("BLOCK");
    expect(r.claims.some((c: Json) => c.rule === "decision-forbids" && c.subject.id === "D-003")).toBe(true);
    const limitation = r.limitations.find((l: Json) => l.code === "decision-patterns-unsupported");
    expect(limitation.message).toContain('D-003 forbids.paths "src/**.ts"');
    expect(limitation.message).not.toMatch(/not checked|did not check|match no file/u);
  });
});

