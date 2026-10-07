/**
 * H-76 (T42, F-23): an explicit primary seed (a Requirement or Issue named by its exact ID in the task text) gets
 * its full representation before lower-ranked transitive candidates. The fixture has the shape of the OpenHub
 * repository where the problem was found: one Requirement tracked by seven Issues and validated by about thirty
 * tests of other Issues, and two Issues with six and seven acceptance criteria.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { definitionRef, fileRef, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderContextMarkdown } from "./render.js";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextPacket, ContextResult, PacketItem } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const AC: Record<string, number> = { "TASK-008": 4, "TASK-009": 5, "TASK-010": 6, "TASK-011": 3, "TASK-012": 3, "TASK-013": 3, "TASK-014": 7 };
const TESTS: Record<string, number> = { "TASK-008": 10, "TASK-009": 11, "TASK-014": 8 };

function issue(id: string): string {
  const n = id.slice(5);
  const acs = Array.from({ length: AC[id] ?? 0 }, (_, k) => `- **AC-${n}-${String(k + 1).padStart(2, "0")}** ${id} criterion ${k + 1}: the analyzer reports every detected item with its evidence path, confidence and source detector, and a second run over the same project produces byte-identical output.`);
  return [
    `## ${id} Analyzer work item ${n}`, "", "```duo", "type: issue", "status: todo", "milestone: M2", "requirements: [REQ-010]", "```", "",
    `${id} body: build the part of the project analyzer that this item owns. It reuses the profile contract, keeps every parser behind the safe scanner, never reads outside the project root and records why each detection was made so that a reviewer can trace it back to a file and a line.`,
    "", ...acs, "",
  ].join("\n");
}

function testFile(task: string): string {
  const n = task.slice(5);
  const cases = Array.from({ length: TESTS[task] ?? 0 }, (_, k) => [
    `  it("AC-${n}-${String((k % (AC[task] ?? 1)) + 1).padStart(2, "0")} case ${k + 1} keeps detections stable", () => {`,
    `    const profile = analyze({ root: "fixtures/project-${k + 1}", detectors: ["language", "runtime", "framework"] });`,
    `    expect(profile.schemaVersion).toBe(1);`,
    `    expect(profile.items.map((i) => i.id)).toEqual(expected${k + 1}.map((i) => i.id));`,
    `    expect(profile.items.every((i) => i.evidence.length > 0 && i.confidence > 0)).toBe(true);`,
    `    expect(analyze({ root: "fixtures/project-${k + 1}", detectors: ["language"] })).toEqual(analyze({ root: "fixtures/project-${k + 1}", detectors: ["language"] }));`,
    `    const runtime = profile.items.find((i) => i.id === "runtime");`,
    `    expect(runtime?.evidence).toContain("fixtures/project-${k + 1}");`,
    `    expect(profile.items.filter((i) => i.confidence >= 0.9).length).toBeGreaterThanOrEqual(expected${k + 1}.filter((i) => i.strong).length);`,
    `    expect(JSON.stringify(profile)).not.toContain("node_modules");`,
    `    expect(profile.items.map((i) => i.evidence.join(","))).toMatchSnapshot("evidence-${k + 1}");`,
    "  });",
  ].join("\n"));
  return [`import { describe, expect, it } from "vitest";`, `import { analyze } from "../src/analyze";`, "", `describe("REQ-010 ${task} analyzer", () => {`, ...cases, "});", ""].join("\n");
}

/** An Issue whose full specification is larger than a tight budget (not linked to REQ-010, so the other cases are unaffected). */
function oversized(): string {
  const acs = Array.from({ length: 80 }, (_, k) => `- **AC-099-${String(k + 1).padStart(2, "0")}** oversized analyzer work item criterion ${k + 1}: every detector result names its evidence file, line, confidence and detector, and stays identical across two runs.`);
  return ["## TASK-099 Oversized analyzer work item", "", "```duo", "type: issue", "status: todo", "```", "", "TASK-099 body: an item whose specification is long on purpose.", "", ...acs, ""].join("\n");
}

export function writeOpenHubLike(dir: string): void {
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w("package.json", JSON.stringify({ name: "openhub-like", version: "1.0.0", type: "module" }, null, 2) + "\n");
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022" } }, null, 2) + "\n");
  w(".duo-project/project.yaml", "schema_version: 1\nname: openhub-like\ncurrent_milestone: M2\n");
  w(".duo-project/milestones/M2.yaml", `id: M2\ntitle: Project analyzer\nstate: active\nissues: [${Object.keys(AC).join(", ")}]\n`);
  w(".duo-project/specs/product.md", ["# Product", "", "## REQ-010 Project scanner and stack detector", "", "```duo", "status: planned", "milestone: M2", "priority: must", "```", "",
    "Analyze the manifests, lock files and build files of a project folder and report its languages, frameworks, databases and infrastructure with evidence for every item.", ""].join("\n"));
  w(".duo-project/specs/m2.md", ["# M2 analyzer", "", ...Object.keys(AC).map(issue), oversized()].join("\n"));
  w(".duo-project/decisions/proposals/P-001.yaml", "id: P-001\ntitle: Detector plugin loading\nstate: proposed\nquestion: plugins\nanswer: load detectors from a fixed list only\ngoverns:\n  requirements: [REQ-010]\nproposed_by: codex\nproposed_by_kind: agent\n");
  w(".duo-project/decisions/D-002.yaml", "id: D-002\ntitle: Static parsers only\nkind: decision\nstate: confirmed\nquestion: parsers\nanswer: structured parsers for JSON, YAML, TOML and XML; no code execution\nowner: human\ngoverns:\n  requirements: [REQ-010]\nconfirmed_at: \"2026-10-06T00:00:00Z\"\nconfirmed_by: tester\n");
  w("src/analyze.ts", "// duo: REQ-010\nexport interface Item { readonly id: string; readonly evidence: readonly string[]; readonly confidence: number }\nexport function analyze(input: { root: string; detectors: readonly string[] }): { schemaVersion: 1; items: Item[] } {\n  return { schemaVersion: 1, items: input.detectors.map((d) => ({ id: d, evidence: [input.root], confidence: 1 })) };\n}\n");
  for (const t of Object.keys(TESTS)) w(`test/${t.toLowerCase()}.test.ts`, testFile(t));
}

const acCount = (item: PacketItem | undefined, id: string): number => (item?.text.match(new RegExp(`AC-${id.slice(5)}-\\d{2}`, "gu")) ?? []).filter((v, i, a) => a.indexOf(v) === i).length;
const seedItem = (r: ContextResult, ref: string) => r.packet?.issues.find((i) => i.ref === ref) ?? r.packet?.intent.requirements.find((i) => i.ref === ref);

describe("H-76 explicit primary seeds keep their full specification (F-23)", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-openhub-like-"));
    temps.push(fixture);
    writeOpenHubLike(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    await repo.index();
  });

  for (const [task, budget] of [["TASK-014", 6000], ["TASK-014", 12000], ["TASK-010", 6000], ["TASK-010", 12000]] as const) {
    it(`A-D ${task} at budget ${budget}: L3 with its body and every acceptance criterion, within the budget`, async () => {
      const r = await repo.compile({ task, budget });
      const seed = seedItem(r, task);
      expect(seed?.level).toBe("L3");
      expect(seed?.text).toContain(`${task} body:`);
      expect(acCount(seed, task)).toBe(AC[task]);
      expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(budget);
      expect(r.packet?.limitations.map((l) => l.code)).not.toContain("explicit-seed-truncated");
    });
  }
});

describe("H-76 who gets the privilege, oversized and multiple seeds, unchanged guarantees", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  const tight = 2500;
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-openhub-like-"));
    temps.push(fixture);
    writeOpenHubLike(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    await repo.index();
  });
  const limits = (r: ContextResult) => r.packet?.limitations.filter((l) => l.code === "explicit-seed-truncated").map((l) => l.message) ?? [];

  it("E a Requirement named by its ID keeps its full representation", async () => {
    const r = await repo.compile({ task: "REQ-010", budget: 6000 });
    expect(r.packet?.seeds).toMatchObject([{ ref: "REQ-010", match: "id" }]);
    const req = seedItem(r, "REQ-010");
    expect(req?.level).toBe("L3");
    expect(req?.text).toContain("with evidence for every item");
  });

  it("F a keyword-only Issue hit gets no explicit-seed privilege", async () => {
    const r = await repo.compile({ task: "oversized analyzer work item", budget: tight });
    const seed = r.packet?.seeds.find((s) => s.ref === "TASK-099");
    expect(seed?.match).toBe("keyword");
    expect(seedItem(r, "TASK-099")?.level).not.toBe("L3");
    expect(limits(r)).toEqual([]);
  });

  it("G a Review diff seed gets no explicit-seed privilege, even when the task names the same ID", async () => {
    for (const task of ["", "TASK-099"]) {
      const r = await repo.compile({ task, budget: tight, profile: "review", explicitSeeds: [definitionRef("issue", "TASK-099")] });
      expect(r.packet?.seeds.find((s) => s.ref === "TASK-099")?.match).toBe("diff");
      expect(seedItem(r, "TASK-099")?.level).not.toBe("L3");
      expect(limits(r)).toEqual([]);
    }
  });

  it("H exact path and symbol seeds get no explicit-seed privilege", async () => {
    const r = await repo.compile({ task: "test/task-008.test.ts analyze", budget: tight });
    expect(r.packet?.seeds.map((s) => s.match).sort()).toEqual(expect.arrayContaining(["path"]));
    expect(r.packet?.seeds.some((s) => s.match === "symbol" || s.match === "symbol-name")).toBe(true);
    expect(limits(r)).toEqual([]);
  });

  it("I a seed whose full specification does not fit: highest fitting level, a limitation that names it, the budget kept", async () => {
    const r = await repo.compile({ task: "TASK-099", budget: tight });
    const seed = seedItem(r, "TASK-099");
    expect(seed?.level).not.toBe("L3");
    expect(seed).toBeDefined();
    expect(limits(r)).toEqual([expect.stringMatching(new RegExp(`^Explicit seed TASK-099 could not fit its full specification within the ${tight}-token budget \\(\\d+ tokens\\); the highest fitting representation \\(L[12]\\) is shown\\.$`, "u"))]);
    expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(tight);
  });

  it("J several explicit IDs: deterministic, whatever order the task names them in", async () => {
    const both = await repo.compile({ task: "TASK-010 TASK-014", budget: 12000 });
    expect([seedItem(both, "TASK-010")?.level, seedItem(both, "TASK-014")?.level]).toEqual(["L3", "L3"]);
    const levels = async (task: string) => {
      const r = await repo.compile({ task, budget: tight });
      expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(tight);
      return { items: [...(r.packet?.issues ?? []), ...(r.packet?.tests ?? [])].map((i) => `${i.ref}:${i.level}`), limits: limits(r) };
    };
    const a = await levels("TASK-014 TASK-099");
    expect(await levels("TASK-099 TASK-014")).toEqual(a);
    expect(await levels("TASK-014 TASK-099")).toEqual(a);
    expect(a.items).toContain("TASK-014:L3"); // plan order: TASK-014 before TASK-099
    expect(a.limits).toEqual([expect.stringMatching(/^Explicit seed TASK-099 /u)]);
  });

  it("K active Decisions stay mandatory; L the pending-decision notice is unchanged", async () => {
    for (const budget of [tight, 6000, 12000]) {
      const r = await repo.compile({ task: "TASK-014", budget });
      expect(r.packet?.decisions.active.map((d) => d.ref)).toContain("D-002");
      expect(r.packet?.pendingDecisions.map((p) => p.id)).toEqual(["P-001"]);
      const md = renderContextMarkdown(r.packet as ContextPacket);
      expect(md).toContain("## PENDING HUMAN DECISIONS");
      expect(md).toContain("do not implement them as decided");
    }
  });

  it("M the dependency digest is deterministic; N a cache hit is byte-identical", async () => {
    const a = await repo.compile({ task: "TASK-014", budget: 6000 }, { cache: true });
    const b = await repo.compile({ task: "TASK-014", budget: 6000 }, { cache: true });
    expect(a.cache.status).toBe("miss");
    expect(b.cache.status).toBe("hit");
    expect(b.packet?.dependencyDigest).toBe(a.packet?.dependencyDigest);
    expect(JSON.stringify(b.packet)).toBe(JSON.stringify(a.packet));
    expect(renderContextMarkdown(b.packet as ContextPacket)).toBe(renderContextMarkdown(a.packet as ContextPacket));
    const fresh = await repo.compile({ task: "TASK-014", budget: 6000 });
    expect(fresh.packet?.dependencyDigest).toBe(a.packet?.dependencyDigest);
  });
});

describe("H-76 a Review with many diff seeds does not pin them all at full size", () => {
  it("50 file diff seeds in the review profile: budget kept, no explicit-seed limitation, not everything at L3", async () => {
    const registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-openhub-like-"));
    temps.push(fixture);
    writeOpenHubLike(fixture);
    const files = Array.from({ length: 50 }, (_, k) => `src/detectors/d${String(k + 1).padStart(2, "0")}.ts`);
    for (const [k, f] of files.entries()) {
      const body = Array.from({ length: 12 }, (_, j) => `  if (input.includes("marker-${k}-${j}")) return ${j};`).join("\n");
      fs.mkdirSync(path.dirname(path.join(fixture, f)), { recursive: true });
      fs.writeFileSync(path.join(fixture, f), `// duo: REQ-010\nexport function detect${k + 1}(input: string): number {\n${body}\n  return -1;\n}\n`);
    }
    const repo = makeContextRepo(temps, registry, fixture);
    await repo.index();
    const r = await repo.compile({ task: "", budget: 6000, profile: "review", explicitSeeds: files.map((f) => fileRef(f as RepoPath)) });
    expect(r.packet?.seeds.filter((s) => s.match === "diff")).toHaveLength(50);
    expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(6000);
    expect(r.packet?.limitations.map((l) => l.code)).not.toContain("explicit-seed-truncated");
    const code = r.packet?.code ?? [];
    expect(code.filter((i) => i.level === "L3").length).toBeLessThan(50);
  });
});

