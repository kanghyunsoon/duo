/**
 * 0.2.2 safety floor (H-75, C243, C244), end to end with the built duoctl and its MCP server.
 * A confirmed Decision the loader cannot read, including one written by a newer DUO with a field this version does
 * not know (forbids.imported_paths from 0.3), never turns into a PASS: review, context and Decision confirm/reject
 * refuse with PROJECT_TRUTH_INVALID, and status, doctor, decision list and MCP name the file. Valid Truth is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { createDecisionService } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectReview } from "../../packages/integration/src/operations/review.js";
import { startMcp, type McpSession } from "../mcp/support.js";
import { duoctl, existingProject, type Project } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
const sessions: McpSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const D001 = "id: D-001\ntitle: Legacy db stays frozen\nkind: decision\nstate: proposed\nquestion: legacy_db\nanswer: src/db/legacy-db.ts is not changed\nforbids:\n  paths: [\"src/db/**\"]\nenforcement: block\n";
const LEGACY = "export class LegacyDb {\n  run(sql: string): string[] {\n    return [sql];\n  }\n}\n";
const CHANGED = LEGACY.replace("return [sql];", "return [sql, sql];");
/** Truth and history files with their content (regenerable generated/, cache/ and runtime/ left out). */
const truthFiles = (root: string) => fs.readdirSync(path.join(root, ".duo-project"), { recursive: true, encoding: "utf8" })
  .filter((f) => !/^(generated|cache|runtime)([\\/]|$)/u.test(f) && fs.statSync(path.join(root, ".duo-project", f)).isFile()).sort()
  .map((f) => [f, fs.readFileSync(path.join(root, ".duo-project", f), "utf8")]);

describe("0.2.2: partial or unknown Project Truth fails closed (C243, C244)", () => {
  let p: Project;
  let confirmed: string;
  beforeAll(async () => {
    p = existingProject(temps);
    p.write("src/db/legacy-db.ts", LEGACY);
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
    p.write("src/db/legacy-db.ts", CHANGED); // a change D-001 blocks
    expect(duoctl(p.root, ["index"]).code).toBe(0);
  });

  it("valid Truth: the change D-001 forbids still blocks and status, doctor and decision list report no Truth error", () => {
    const r = duoctl(p.root, ["review", "--json"]).json();
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.result.verdict).toBe("BLOCK");
    expect(r.diagnostics.map((d: { code: string }) => d.code)).not.toContain("PROJECT_TRUTH_INVALID");
    expect(duoctl(p.root, ["status", "--json"]).json().result.truth.errors).toEqual([]);
    expect(duoctl(p.root, ["status"]).stdout).not.toContain("Truth errors");
    expect(duoctl(p.root, ["decision", "list"]).stdout).not.toContain("Not listed");
  });

  it("a confirmed block Decision with a 0.3-only field: review, context, status, doctor, decision list, MCP and the UI route never show it as fine", async () => {
    p.write(".duo-project/decisions/D-001.yaml", confirmed.replace("forbids:\n", "forbids:\n  imported_paths: [\"src/db/legacy-db.ts\"]\n"));
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
    expect(reviewJson.result).toBeNull();
    expect(reviewJson.diagnostics.map((d: { code: string }) => d.code)).toEqual(expect.arrayContaining(["PROJECT_TRUTH_INVALID", "SCHEMA_UNKNOWN_PROPERTY"]));
    expect(duoctl(p.root, ["review", "--fail-on", "block"]).code).toBe(1);

    expect(duoctl(p.root, ["context", "Scheduler.next"]).code).toBe(1);

    const status = duoctl(p.root, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Truth errors: 1");
    expect(status.stdout).toContain(".duo-project/decisions/D-001.yaml");
    expect(duoctl(p.root, ["status", "--json"]).json().result.truth.errors).toMatchObject([{ code: "SCHEMA_UNKNOWN_PROPERTY", path: ".duo-project/decisions/D-001.yaml" }]);

    const doctor = duoctl(p.root, ["doctor"]);
    expect(doctor.code).not.toBe(0);
    expect(doctor.stdout + doctor.stderr).toContain("Project Truth cannot be read: SCHEMA_UNKNOWN_PROPERTY (.duo-project/decisions/D-001.yaml)");
    expect(doctor.stdout + doctor.stderr).not.toMatch(/DUO Doctor · ready/u);
    expect(duoctl(p.root, ["decision", "list"]).stdout).toContain("Not listed: 1 Truth error(s)");

    const service = createDecisionService({ root: p.root });
    const human = { kind: "human", name: "Ada Lovelace" } as const;
    for (const op of [await service.confirm(human, "D-001"), await service.reject(human, "P-001")]) {
      expect(op.value).toBeUndefined();
      expect(op.diagnostics.map((d) => d.code)).toContain("PROJECT_TRUTH_INVALID");
    }

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

  it("malformed YAML, a wrong type, an unknown field and a broken proposal all fail closed; fixed Truth reviews again", () => {
    const variants: [string, string, string][] = [
      [".duo-project/decisions/D-001.yaml", confirmed + "future_rule:\n  calls: [LegacyDb.run]\n", "SCHEMA_UNKNOWN_PROPERTY"],
      [".duo-project/decisions/D-001.yaml", confirmed + "forbids: [unclosed\n", "YAML_SYNTAX_ERROR"],
      [".duo-project/decisions/D-001.yaml", confirmed.replace("enforcement: block", "enforcement: 5"), "SCHEMA_INVALID_VALUE"],
      [".duo-project/decisions/proposals/P-001.yaml", "id: P-001\ntitle: x\nstate: proposed\nquestion: q\nanswer: a\nbogus: 1\n", "SCHEMA_UNKNOWN_PROPERTY"],
    ];
    for (const [file, text, code] of variants) {
      p.write(".duo-project/decisions/D-001.yaml", confirmed);
      fs.rmSync(path.join(p.root, ".duo-project/decisions/proposals"), { recursive: true, force: true });
      p.write(file, text);
      expect(duoctl(p.root, ["index"]).code).toBe(0);
      const r = duoctl(p.root, ["review", "--json"]).json();
      expect(r.exitCode, code).toBe(1);
      expect(r.result, code).toBeNull();
      expect(r.diagnostics.map((d: { code: string }) => d.code), code).toEqual(expect.arrayContaining(["PROJECT_TRUTH_INVALID", code]));
    }
    p.write(".duo-project/decisions/D-001.yaml", confirmed);
    fs.rmSync(path.join(p.root, ".duo-project/decisions/proposals"), { recursive: true, force: true });
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    expect(duoctl(p.root, ["review", "--json"]).json().result.verdict).toBe("BLOCK");
  });
});
