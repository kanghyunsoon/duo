import fs from "node:fs";
import { definitionRef, fileRef, symbolRef, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { indexRepository } from "../incremental/indexer.js";
import { baseRegistry, makeRepo, memoryStore } from "../incremental/testing.js";
import type { GraphStore } from "../store/types.js";
import { impact } from "./impact.js";
import { trace } from "./trace.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const temps: string[] = [];
let store: GraphStore;
const p = (s: string) => s as RepoPath;

beforeAll(async () => {
  const registry = await baseRegistry();
  const repo = makeRepo(temps);
  for (const message of ["APP-10 tweak", "UTF-8 fix", "more"]) {
    for (const f of ["src/auth/login.ts", "src/app.ts"]) fs.appendFileSync(`${repo.root}/${f}`, `// ${message}\n`);
    repo.git("commit", "-q", "-am", message);
  }
  store = memoryStore();
  const r = await indexRepository(repo.root, { store, registry });
  registry.dispose();
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
});
afterAll(() => {
  store?.close();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const rows = (r: ReturnType<typeof impact>) => r.items.map((i) => `${i.relation} ${i.depth} ${i.id} (${i.via.edge} ${i.via.direction})`);

describe("AC-008-04 impact() and trace() on the graph fixture", () => {
  it("impact of a changed file: importers, governing Decision and Requirements are direct; its symbols structural", () => {
    const r = impact(store, [fileRef(p("src/auth/login.ts"))]);
    expect(r.evidence).toBe("graph");
    expect(r.truncated).toBe(false);
    expect(rows(r)).toEqual([
      "direct 1 dec:D-001 (GOVERNS incoming)",
      "direct 1 file:src/app.ts (IMPORTS incoming)",
      "direct 1 file:src/auth/index.ts (IMPORTS incoming)",
      "direct 1 file:test/app.test.ts (IMPORTS incoming)",
      "direct 2 req:APP-02 (IMPLEMENTS outgoing)",
      "structural 1 sym:src/auth/login.ts#login (CONTAINS outgoing)",
      "structural 1 sym:src/auth/login.ts#logout (CONTAINS outgoing)",
      "structural 1 sym:src/auth/login.ts#validate (CONTAINS outgoing)",
      "structural 2 req:APP-01 (IMPLEMENTS outgoing)",
      "structural 2 sym:src/app.ts#main (CALLS incoming)",
      "structural 2 test:test/app.test.ts#App > logs in (VALIDATED_BY outgoing)",
    ]);
  });

  it("impact of a changed symbol: callers first, then their files", () => {
    expect(rows(impact(store, [symbolRef(p("src/shared/format.ts"), "format")]))).toEqual([
      "direct 1 sym:src/app.ts#main (CALLS incoming)",
      "direct 1 sym:src/legacy.js#legacy (CALLS incoming)",
      "direct 1 sym:test/app.test.ts#helper (CALLS incoming)",
      "structural 1 file:src/shared/format.ts (CONTAINS incoming)",
      "structural 2 file:src/app.ts (CONTAINS incoming)",
      "structural 2 file:src/legacy.js (CONTAINS incoming)",
      "structural 2 file:test/app.test.ts (CONTAINS incoming)",
    ]);
  });

  it("co-change is historical and ranked last", () => {
    expect(rows(impact(store, [fileRef(p("src/app.ts"))], { maxDepth: 1 }))).toEqual([
      "direct 1 req:APP-02 (IMPLEMENTS outgoing)",
      "structural 1 sym:src/app.ts#main (CONTAINS outgoing)",
      "historical 1 file:src/auth/login.ts (CHANGED_WITH outgoing)",
    ]);
  });

  it("is bounded", () => {
    const r = impact(store, [fileRef(p("src/auth/login.ts"))], { nodeLimit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(impact(store, [fileRef(p("src/auth/login.ts"))], { maxDepth: 0 }).items).toEqual([]);
  });

  it("trace of a Requirement: Decisions, Issue, Milestone, dependent Requirement, implementing Symbol, validating Test", () => {
    const r = trace(store, definitionRef("requirement", "APP-01"), { maxDepth: 1 });
    expect(r.nodes.map((n) => `${n.depth} ${n.node.id}`)).toEqual([
      "0 req:APP-01",
      "1 dec:D-001",
      "1 dec:D-002",
      "1 issue:APP-10",
      "1 ms:M1",
      "1 req:APP-02",
      "1 sym:src/auth/login.ts#login",
      "1 test:test/app.test.ts#App > logs in",
    ]);
  });
});

