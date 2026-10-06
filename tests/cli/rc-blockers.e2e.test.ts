/**
 * T40 RC blockers, end to end with the built duoctl and its MCP server.
 * N1: a confirmed Decision the loader cannot read never turns into a PASS; every surface names the file.
 * N3: governs does not scope forbids; the agent-facing description and the preview say so, review is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { createDecisionService } from "@duo-director/core";
import { projectReview } from "@duo-director/integration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMcp, type McpSession } from "../mcp/support.js";
import { duoctl, existingProject, type Project } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
const sessions: McpSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const D001 = "id: D-001\ntitle: No legacy-db imports from UI code\nkind: decision\nstate: proposed\nquestion: legacy_db\nanswer: UI code does not import src/db/legacy-db.ts\ngoverns:\n  paths: [\"src/ui/**\"]\nforbids:\n  imported_paths: [\"src/db/legacy-db.ts\"]\nenforcement: block\n";
const REPORT = "import { LegacyDb } from \"../db/legacy-db.js\";\n\nexport const rows = new LegacyDb().run(\"x\");\n";
/** Truth and history files with their content (regenerable generated/, cache/ and runtime/ left out). */
const truthFiles = (root: string) => fs.readdirSync(path.join(root, ".duo-project"), { recursive: true, encoding: "utf8" })
  .filter((f) => !/^(generated|cache|runtime)([\\/]|$)/u.test(f) && fs.statSync(path.join(root, ".duo-project", f)).isFile()).sort()
  .map((f) => [f, fs.readFileSync(path.join(root, ".duo-project", f), "utf8")]);

describe("T40 RC blockers: partial Truth fails closed (N1), forbids scope is stated (N3)", () => {
  let p: Project;
  let confirmed: string;
  beforeAll(async () => {
    p = existingProject(temps);
    p.write("src/db/legacy-db.ts", "export class LegacyDb {\n  run(sql: string): string[] {\n    return [sql];\n  }\n}\n");
    p.write("src/ui/page.ts", "export const page = \"orders\";\n");
    p.git("add", "-A");
    p.git("commit", "-qm", "legacy db");
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }])).code).toBe(0);
    p.git("add", "-A");
    p.git("commit", "-qm", "adopt DUO");
    p.write(".duo-project/decisions/D-001.yaml", D001);
    expect((await createDecisionService({ root: p.root }).confirm({ kind: "human", name: "Ada Lovelace" }, "D-001")).value?.decisionId).toBe("D-001");
    p.git("add", "-A");
    p.git("commit", "-qm", "confirm D-001");
    confirmed = p.read(".duo-project/decisions/D-001.yaml");
    expect(duoctl(p.root, ["index"]).code).toBe(0);
  });

  it("N3: an import outside governs.paths still blocks; the preview and the agent description say forbids are repository-wide", async () => {
    p.write("src/reports/export.ts", REPORT);
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    const r = duoctl(p.root, ["review", "--json"]).json().result;
    expect(r.verdict).toBe("BLOCK");
    expect(r.claims.filter((c: { rule: string }) => c.rule === "decision-forbids-import")).toMatchObject([{ reason: "forbidden-import", provenance: "introduced", blockEligible: true }]);
    expect(r.claims.find((c: { rule: string }) => c.rule === "decision-forbids-import").observed).toContain("src/reports/export.ts");
    fs.rmSync(path.join(p.root, "src/reports"), { recursive: true });
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    const s = await startMcp(p.root);
    sessions.push(s);
    const { tools } = await s.client.listTools();
    const description = tools.find((t) => t.name === "duo_propose_decision")?.description ?? "";
    expect(description).toContain("it does not scope forbids");
    expect(description).toContain("Forbids are repository-wide");
  });

  it("N1: a confirmed block Decision with an unknown field: review, context, status, doctor, decision list and MCP never show it as fine", async () => {
    p.write(".duo-project/decisions/D-001.yaml", confirmed + "future_rule:\n  calls: [LegacyDb.run]\n");
    p.write("src/reports/export.ts", REPORT); // a change D-001 would block if it were read
    expect(duoctl(p.root, ["index"]).code).toBe(0); // the index stays tolerant
    const before = truthFiles(p.root);

    const review = duoctl(p.root, ["review"]);
    expect(review.code).toBe(1);
    expect(review.stdout + review.stderr).toContain("PROJECT_TRUTH_INVALID");
    expect(review.stdout + review.stderr).toContain("SCHEMA_UNKNOWN_PROPERTY");
    expect(review.stdout + review.stderr).toContain(".duo-project/decisions/D-001.yaml");
    expect(review.stdout).not.toMatch(/\bPASS\b|\bWARN\b|\bBLOCK\b/u);
    const reviewJson = duoctl(p.root, ["review", "--json"]).json();
    expect(reviewJson).toMatchObject({ ok: false, exitCode: 1 });
    expect(reviewJson.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["PROJECT_TRUTH_INVALID", "SCHEMA_UNKNOWN_PROPERTY"]));

    expect(duoctl(p.root, ["context", "Scheduler.next"]).code).toBe(1);

    const status = duoctl(p.root, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Truth errors: 1");
    expect(status.stdout).toContain(".duo-project/decisions/D-001.yaml");
    expect(duoctl(p.root, ["status", "--json"]).json().result.truth.errors).toMatchObject([{ code: "SCHEMA_UNKNOWN_PROPERTY", path: ".duo-project/decisions/D-001.yaml" }]);

    const doctor = duoctl(p.root, ["doctor"]);
    expect(doctor.code).toBe(6); // action required
    expect(doctor.stdout + doctor.stderr).toContain("Project Truth cannot be read: SCHEMA_UNKNOWN_PROPERTY (.duo-project/decisions/D-001.yaml)");
    expect(doctor.stdout + doctor.stderr).not.toMatch(/DUO Doctor · ready/u);
    expect(duoctl(p.root, ["decision", "list"]).stdout).toContain("Not listed: 1 Truth error(s)");

    const s = await startMcp(p.root);
    sessions.push(s);
    const mcp = await s.call("duo_review_changes", {});
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent).toBeUndefined();
    expect(mcp.content[0]?.text).toContain("PROJECT_TRUTH_INVALID");
    expect((await s.call("duo_get_status")).structuredContent.truth.errors).toHaveLength(1);
    // The UI review route returns the shared operation as it is: failed, no ReviewResult and no verdict.
    expect((await projectReview(p.root, { diff: { from: "HEAD", to: "WORKTREE" } })).kind).toBe("failed");

    expect(truthFiles(p.root)).toEqual(before); // nothing repaired, removed or rewritten
  });

  it("N1 variants: malformed YAML, a wrong type, an unknown forbids property and a broken proposal all fail closed", () => {
    const variants: [string, string, string][] = [
      [".duo-project/decisions/D-001.yaml", confirmed + "forbids: [unclosed\n", "YAML_SYNTAX_ERROR"],
      [".duo-project/decisions/D-001.yaml", confirmed.replace("enforcement: block", "enforcement: 5"), "SCHEMA_INVALID_VALUE"],
      [".duo-project/decisions/D-001.yaml", confirmed.replace("forbids:\n", "forbids:\n  imported_pathz:\n    - src/db/**\n"), "SCHEMA_UNKNOWN_PROPERTY"],
      [".duo-project/decisions/proposals/P-001.yaml", "id: P-001\ntitle: x\nstate: proposed\nquestion: q\nanswer: a\nbogus: 1\n", "SCHEMA_UNKNOWN_PROPERTY"],
    ];
    for (const [file, text, code] of variants) {
      p.write(".duo-project/decisions/D-001.yaml", confirmed);
      fs.rmSync(path.join(p.root, ".duo-project/decisions/proposals"), { recursive: true, force: true });
      p.write(file, text);
      expect(duoctl(p.root, ["index"]).code).toBe(0);
      const r = duoctl(p.root, ["review", "--json"]).json();
      expect(r.exitCode, code).toBe(1);
      expect(r.diagnostics.map((d) => d.code), code).toEqual(expect.arrayContaining(["PROJECT_TRUTH_INVALID", code]));
    }
    // Fixed Truth reviews again (the change still breaks D-001).
    p.write(".duo-project/decisions/D-001.yaml", confirmed);
    fs.rmSync(path.join(p.root, ".duo-project/decisions/proposals"), { recursive: true, force: true });
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    expect(duoctl(p.root, ["review", "--json"]).json().result.verdict).toBe("BLOCK");
  });
});
