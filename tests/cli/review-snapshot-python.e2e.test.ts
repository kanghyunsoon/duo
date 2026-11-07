/**
 * #160 Stage 2, Python imports (H-103), end to end with the built duoctl and its MCP server: a staged Python import
 * whose forbidden target exists in the reviewed snapshot but not in the working tree gives no verdict on any surface.
 * Before this change it was a PASS.
 */
import fs from "node:fs";
import path from "node:path";
import { createDecisionService } from "@duo-director/core";
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

const TARGET = "app/db/legacy_db.py";
const D001 = `id: D-001\ntitle: No legacy_db imports\nkind: decision\nstate: proposed\nquestion: legacy_db\nanswer: Code does not import ${TARGET}\nforbids:\n  imported_paths: ["${TARGET}"]\nenforcement: block\n`;
const PAGE = "from app.db.legacy_db import legacy_query\n\n\ndef page():\n    return legacy_query(\"x\")\n";
const VERDICT = /\b(PASS|WARN|BLOCK|ASK)\b/u;
const firstMessage = (j: { diagnostics: unknown }) => (j.diagnostics as { code: string; message: string }[])[0]?.message ?? "";
const records = (root: string) => fs.existsSync(path.join(root, ".duo-project/reviews")) ? fs.readdirSync(path.join(root, ".duo-project/reviews")).sort() : [];

describe("#160 Stage 2: a Python import target that differs from the staged snapshot gives no verdict", () => {
  let p: Project;
  let mcp: McpSession;
  beforeAll(async () => {
    p = existingProject(temps);
    for (const f of ["app/__init__.py", "app/db/__init__.py", "app/ui/__init__.py"]) p.write(f, "");
    p.write(TARGET, "def legacy_query(sql):\n    return sql\n");
    p.git("add", "-A");
    p.git("commit", "-qm", "python app");
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    p.git("add", "-A");
    p.git("commit", "-qm", "adopt DUO");
    p.write(".duo-project/decisions/D-001.yaml", D001);
    expect((await createDecisionService({ root: p.root }).confirm({ kind: "human", name: "Ada Lovelace" }, "D-001")).value?.decisionId).toBe("D-001");
    p.git("add", "-A");
    p.git("commit", "-qm", "confirm D-001");
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    mcp = await startMcp(p.root);
    sessions.push(mcp);
  });

  it("--staged: BLOCK on the snapshot; with the target deleted only in the working tree, no verdict on CLI, MCP and Review Record", async () => {
    p.write("app/ui/page.py", PAGE);
    p.git("add", "app/ui/page.py");
    expect(duoctl(p.root, ["review", "--staged", "--refresh", "--json"]).json().result.verdict).toBe("BLOCK");
    fs.rmSync(path.join(p.root, TARGET)); // only the working tree loses the target
    expect(duoctl(p.root, ["index"]).code).toBe(0);
    const before = records(p.root);
    const json = duoctl(p.root, ["review", "--staged", "--json"]).json();
    expect(json).toMatchObject({ ok: false, exitCode: 1 });
    expect(json.result ?? null).toBeNull();
    expect(json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["REVIEW_SNAPSHOT_MISMATCH"]);
    expect(firstMessage(json)).toContain(TARGET);
    const human = duoctl(p.root, ["review", "--staged"]);
    expect(human.code).toBe(1);
    expect(human.stdout).not.toMatch(VERDICT);
    expect(duoctl(p.root, ["review", "--staged", "--record"]).code).toBe(1);
    expect(records(p.root)).toEqual(before);
    const m = await mcp.call("duo_review_changes", { from: "HEAD", to: "INDEX" });
    expect(m.isError).toBe(true);
    expect(m.content[0]?.text).toContain("REVIEW_SNAPSHOT_MISMATCH");
    expect(m.content[0]?.text).toContain(TARGET);
    p.git("checkout", "-q", "--", TARGET);
    p.git("reset", "-q");
    fs.rmSync(path.join(p.root, "app/ui/page.py"));
  });
});
