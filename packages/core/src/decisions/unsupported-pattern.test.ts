/**
 * H-104 (#165). Repository patterns support only "*" and "?" within a segment, "**" as a whole segment and a trailing
 * "/" (docs/03-data-model.md). Before this decision unsupported constructs were accepted silently: a
 * forbids.paths rule with a brace list such as "*.{png,webp}" was proposed, confirmed and loaded without a word, and
 * it never fired (0.3.5 and next 4ab480f).
 *
 * Now new input is refused (PROPOSAL_INVALID on propose, the same diagnostic on a confirm that would write a new rule),
 * and a Decision already in Project Truth keeps loading unchanged with a warning naming the pattern. "[" and "]" stay
 * literal characters, and matching stays case-sensitive.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadProjectTruth } from "../loader/project.js";
import { compileRepoPattern, unsupportedPatternSyntax, type RepoPath } from "../paths.js";
import type { DecisionActor } from "./files.js";
import { unsupportedDecisionPatterns } from "./pattern-syntax.js";
import { createDecisionService } from "./service.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const agent: DecisionActor = { kind: "agent", name: "codex" };
const human: DecisionActor = { kind: "human", name: "tester" };
let root: string;
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };
const exists = (p: string) => fs.existsSync(path.join(root, p));
const svc = () => createDecisionService({ root, clock: () => new Date("2026-11-04T00:00:00.000Z") });
const decisionYaml = (pattern: string, state: "confirmed" | "proposed", field = "paths") => [
  "id: D-001", "title: No assets", "kind: decision", "state: " + state, "question: assets", "answer: none", "owner: human",
  "forbids:", "  " + field + ": [" + JSON.stringify(pattern) + "]", "enforcement: block",
  ...(state === "confirmed" ? ['confirmed_at: "2026-11-04T00:00:00Z"', "confirmed_by: tester"] : []), "",
].join("\n");

/** Unsupported syntax: braces and negation are literal; embedded ** acts like * within one segment. */
const UNSUPPORTED = ["src/pikachu/**/*.{png,PNG,webp}", "src/{a,b}/legacy.ts", "!src/pikachu/keep.png", "src/pikachu/**.png", "src/a**/x.ts"];
/** Supported syntax, including literal brackets (Q3), keeps working. */
const SUPPORTED = ["src/pikachu/**/*.png", "src/pikachu/sprite?.png", "public/pikachu/", "src/**", "docs/*.md", "app/[id]/page.tsx", "src/pikachu/[ab].png"];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-glob-")));
  temps.push(root);
  write(".duo-project/project.yaml", "schema_version: 1\nname: glob\n");
});

describe("H-104 Q3/Q4: the matcher is unchanged", () => {
  it("brackets are literal characters, never a character class", () => {
    expect(unsupportedPatternSyntax("app/[id]/page.tsx")).toBeUndefined();
    expect(compileRepoPattern("app/[id]/page.tsx")?.("app/[id]/page.tsx" as RepoPath)).toBe(true);
    expect(compileRepoPattern("src/pikachu/[ab].png")?.("src/pikachu/a.png" as RepoPath)).toBe(false);
  });

  it("matching stays case-sensitive on every OS", () => {
    expect(compileRepoPattern("src/**/*.png")?.("src/C.PNG" as RepoPath)).toBe(false);
  });

  it.each(UNSUPPORTED)("%s is reported as unsupported", (pattern) => {
    expect(unsupportedPatternSyntax(pattern)).toEqual(expect.any(String));
  });
});

describe("H-104 Q1: new input with unsupported syntax is refused", () => {
  it.each(UNSUPPORTED)("a proposal with forbids.paths %s is refused and not written", async (pattern) => {
    const r = await svc().propose(agent, { title: "No assets", question: "assets", answer: "none", forbids: { paths: [pattern] } });
    expect(r.value, "proposal was written").toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toEqual(["PROPOSAL_INVALID", "PATTERN_SYNTAX_UNSUPPORTED"]);
    expect(r.diagnostics[1]?.message).toContain(`forbids.paths pattern "${pattern}"`);
    expect(exists(".duo-project/decisions/proposals/P-001.yaml")).toBe(false);
  });

  it.each([
    ["governs.paths", { governs: { paths: ["src/{a,b}/**"] }, forbids: { dependencies: ["left-pad"] } }],
    ["forbids.imported_paths", { forbids: { imported_paths: ["src/db/*.{ts,js}"] } }],
    ["forbids.importer_paths", { forbids: { imported_paths: ["src/db/legacy.ts"], importer_paths: ["!src/db/**"] } }],
  ])("every pattern field is checked: %s", async (field, fields) => {
    const r = await svc().propose(agent, { title: "No assets", question: "assets", answer: "none", ...fields });
    expect(r.value).toBeUndefined();
    expect(r.diagnostics[0]?.code).toBe("PROPOSAL_INVALID");
    expect(r.diagnostics[1]?.message).toContain(field + " pattern");
  });

  it.each(SUPPORTED)("a proposal with forbids.paths %s is still accepted", async (pattern) => {
    const r = await svc().propose(agent, { title: "No assets", question: "assets", answer: "none", forbids: { paths: [pattern] } });
    expect(r.value?.proposalId).toBe("P-001");
  });

  it("a pending proposal written before this check is not confirmed into a rule that uses unsupported syntax", async () => {
    const proposed = await svc().propose(agent, { title: "No assets", question: "assets", answer: "none", forbids: { paths: ["src/pikachu/**/*.png"] }, enforcement: "block" });
    const file = path.join(root, proposed.value?.path ?? "");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- src/pikachu/**/*.png", '- "src/pikachu/**/*.{png,webp}"'));
    const r = await svc().confirm(human, "P-001");
    expect(r.value).toBeUndefined();
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["PATTERN_SYNTAX_UNSUPPORTED", "error"]]);
    expect(exists(".duo-project/decisions/D-001.yaml")).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("a proposed YAML Decision is not confirmed in place; adding a lock to an already confirmed one is not new input", async () => {
    write(".duo-project/decisions/D-001.yaml", decisionYaml("src/**/*.{png,webp}", "proposed"));
    const inPlace = await svc().confirm(human, "D-001");
    expect(inPlace.value).toBeUndefined();
    expect(inPlace.diagnostics.map((d) => d.code)).toEqual(["PATTERN_SYNTAX_UNSUPPORTED"]);
    write(".duo-project/decisions/D-001.yaml", decisionYaml("src/**/*.{png,webp}", "confirmed"));
    const lock = await svc().confirm(human, "D-001");
    expect(lock.value?.decisionId).toBe("D-001");
    expect(fs.readFileSync(path.join(root, ".duo-project/decisions/D-001.yaml"), "utf8")).toContain("src/**/*.{png,webp}");
  });
});

describe("H-104 Q2: a Decision already in Project Truth loads unchanged and is reported", () => {
  it.each(UNSUPPORTED)("forbids.paths %s: a warning naming the pattern, the value as written", (pattern) => {
    write(".duo-project/decisions/D-001.yaml", decisionYaml(pattern, "confirmed"));
    const loaded = loadProjectTruth(root);
    const d = loaded.value?.truth.decisions.find((x) => x.id === "D-001");
    expect(d?.forbids.paths).toEqual([pattern]);
    const warnings = loaded.diagnostics.filter((x) => x.code === "PATTERN_SYNTAX_UNSUPPORTED");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: "warning", source: { path: ".duo-project/decisions/D-001.yaml" } });
    expect(warnings[0]?.message).toContain(`forbids.paths pattern "${pattern}"`);
    expect(unsupportedDecisionPatterns(loaded.value?.truth ?? { decisions: [] })).toEqual([{ decision: "D-001", field: "forbids.paths", pattern, reason: expect.any(String) }]);
  });

  it("only confirmed Decisions are listed as unchecked rules; a supported pattern is not", () => {
    write(".duo-project/decisions/D-001.yaml", decisionYaml("src/**/*.{png,webp}", "proposed"));
    write(".duo-project/decisions/D-002.yaml", decisionYaml("app/[id]/page.tsx", "confirmed").replace("D-001", "D-002"));
    const loaded = loadProjectTruth(root);
    expect(unsupportedDecisionPatterns(loaded.value?.truth ?? { decisions: [] })).toEqual([]);
    expect(loaded.diagnostics.filter((x) => x.code === "PATTERN_SYNTAX_UNSUPPORTED").map((x) => x.source?.path)).toEqual([".duo-project/decisions/D-001.yaml"]);
  });
});

