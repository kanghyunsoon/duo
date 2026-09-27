import { describe, expect, it } from "vitest";
import { parseDefinitionMarkdown } from "../domain/definitions.js";
import { emptyDefinitionSet } from "../domain/model.js";
import { analyzeTrace, type TracePolicy } from "./trace.js";

const block = (...yaml: string[]) => ["```duo", ...yaml, "```", ""];
const adr = [
  "---", "id: ADR-001", "type: decision", "title: T", "state: confirmed", "question: q", "answer: a",
  "governs:", "  requirements: [REQ-A-001]", "---", "# ADR-001: T",
].join("\n");

function analyze(specLines: string[], policy?: TracePolicy) {
  const defs = emptyDefinitionSet();
  for (const [path, text] of [[".duo-project/specs/s.md", specLines.join("\n")], [".duo-project/decisions/ADR-001.md", adr]] as const) {
    const r = parseDefinitionMarkdown(path, text);
    expect(r.diagnostics).toEqual([]);
    for (const key of Object.keys(defs) as (keyof typeof defs)[]) (defs[key] as unknown[]).push(...(r.value?.[key] ?? []));
  }
  return analyzeTrace(defs, policy);
}

const codes = (r: ReturnType<typeof analyze>) => r.diagnostics.map((d) => [d.code, d.source?.startLine]);
/** REQ-A-001 exists so that the shared ADR-001 reference resolves (6 lines). */
const base = ["## REQ-A-001 First", "", ...block("status: deferred")];

describe("analyzeTrace", () => {
  it("builds links in canonical direction", () => {
    const r = analyze([
      "## REQ-A-001 First", "", ...block("milestone: M1"),
      "## TASK-001 Build", "", ...block("type: issue", "status: todo", "requirements: [REQ-A-001]", "decisions: [ADR-001]"),
      "## M1 One", "", ...block("type: milestone", "title: One", "state: active"),
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.model.links.map((l) => `${l.from.id} ${l.relation} ${l.to.id}`)).toEqual([
      "ADR-001 GOVERNS REQ-A-001",
      "ADR-001 GOVERNS TASK-001",
      "M1 REQUIRES REQ-A-001",
      "REQ-A-001 TRACKED_BY TASK-001",
    ]);
    expect(r.model.entities.get("ADR-001")?.ref).toEqual({ type: "decision", id: "ADR-001" });
  });

  it("reports broken references at the referencing line", () => {
    const r = analyze([...base, "## TASK-001 Build", "", ...block("type: issue", "status: todo", "depends_on: [TASK-000]")]);
    expect(codes(r)).toEqual([["BROKEN_REFERENCE", 12]]);
  });

  it("rejects duplicate IDs across definition types", () => {
    const r = analyze([
      ...base,
      "## X-001 Requirement", "", ...block("status: deferred"),
      "## X-001 Issue", "", ...block("type: issue", "status: todo"),
    ]);
    expect(codes(r)).toEqual([["DUPLICATE_ID", 13]]);
  });

  it("reports a reference to the wrong entity type", () => {
    const r = analyze([...base, "## TASK-001 Build", "", ...block("type: issue", "status: todo", "requirements: [ADR-001]")]);
    expect(codes(r)).toEqual([["REFERENCE_TYPE_MISMATCH", 12]]);
  });

  it("warns when an issue's decision governs none of its requirements", () => {
    const r = analyze([
      "## REQ-A-001 First", "", ...block("status: deferred"),
      "## REQ-A-002 Second", "", ...block("status: deferred"),
      "## TASK-001 Build", "", ...block("type: issue", "status: todo", "requirements: [REQ-A-002]", "decisions: [ADR-001]"),
    ]);
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["TRACE_DECISION_UNRELATED", "warning"]]);
  });

  it("reports untracked requirements as info, or as errors under the policy", () => {
    const spec = ["## REQ-A-001 First", "", ...block("status: planned"), "## REQ-A-002 Later", "", ...block("status: deferred")];
    expect(analyze(spec).diagnostics.map((d) => [d.code, d.severity])).toEqual([["TRACE_REQUIREMENT_UNTRACKED", "info"]]);
    expect(analyze(spec, { requireTrackedRequirements: true }).diagnostics.map((d) => d.severity)).toEqual(["error"]);
  });

  it("rejects duplicate acceptance criterion IDs", () => {
    const r = analyze([
      "## REQ-A-001 First", "", ...block("status: deferred"),
      "## TASK-001 A", "", ...block("type: issue", "status: todo"), "- **AC-001-01** one", "",
      "## TASK-002 B", "", ...block("type: issue", "status: todo"), "- **AC-001-01** two", "",
    ]);
    expect(codes(r)).toEqual([["DUPLICATE_ID", 23]]);
  });

});

describe("analyzeTrace — SUPERSEDES", () => {
  const decision = (id: string, supersedes?: string) => [
    "---", `id: ${id}`, "type: decision", "title: T", "state: confirmed", "question: q", "answer: a",
    ...(supersedes ? [`supersedes: ${supersedes}`] : []), "---", `# ${id}`,
  ].join("\n");
  function run(...decisions: string[]) {
    const defs = emptyDefinitionSet();
    decisions.forEach((text, i) => {
      const r = parseDefinitionMarkdown(`.duo-project/decisions/D${i}.md`, text);
      defs.decisions.push(...(r.value?.decisions ?? []));
    });
    return analyzeTrace(defs);
  }

  it("links new → old", () => {
    const r = run(decision("D-015", "D-004"), decision("D-004"));
    expect(r.diagnostics).toEqual([]);
    expect(r.model.links.map((l) => `${l.from.id} ${l.relation} ${l.to.id}`)).toEqual(["D-015 SUPERSEDES D-004"]);
  });

  it("requires the target decision to exist", () => {
    expect(run(decision("D-015", "D-004")).diagnostics.map((d) => [d.code, d.source?.startLine])).toEqual([["BROKEN_REFERENCE", 8]]);
  });

  it("rejects a decision that supersedes itself", () => {
    const r = run(decision("D-004", "D-004"));
    expect(r.diagnostics.map((d) => d.code)).toEqual(["DECISION_SUPERSEDES_SELF"]);
    expect(r.model.links).toEqual([]);
  });

  it("detects a direct cycle", () => {
    const r = run(decision("D-001", "D-002"), decision("D-002", "D-001"));
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([["DECISION_SUPERSEDE_CYCLE", "Supersede cycle: D-001 → D-002 → D-001"]]);
  });

  it("detects a multi-hop cycle once", () => {
    const r = run(decision("D-001", "D-003"), decision("D-002", "D-001"), decision("D-003", "D-002"));
    expect(r.diagnostics.map((d) => d.code)).toEqual(["DECISION_SUPERSEDE_CYCLE"]);
    expect(r.diagnostics[0]?.message).toBe("Supersede cycle: D-001 → D-003 → D-002 → D-001");
  });

  it("accepts a supersede chain without a cycle", () => {
    expect(run(decision("D-003", "D-002"), decision("D-002", "D-001"), decision("D-001")).diagnostics).toEqual([]);
  });
});

describe("analyzeTrace — milestone membership", () => {
  it("resolves milestone issue references and flags a mismatching issue milestone", () => {
    const r = analyze([
      ...base,
      "## M1 One", "", ...block("type: milestone", "title: One", "state: active", "issues: [TASK-001, TASK-404]"),
      "## M2 Two", "", ...block("type: milestone", "title: Two", "state: planned"),
      "## TASK-001 Build", "", ...block("type: issue", "status: todo", "milestone: M2"),
    ]);
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual(["BROKEN_REFERENCE", "TRACE_MILESTONE_MISMATCH"]);
  });
});
