/**
 * H-71 contract (was H-36): duo_propose_decision may carry forbids, enforcement and supersedes in addition to
 * title, question, answer, rationale and governs. evidence, source, extensions and kind stay out of the
 * agent-facing input. A proposal gains no authority until a human confirms it (DecisionService, Informed Confirm).
 */
import { describe, expect, it } from "vitest";
import { FORBIDS_SYMBOL_MESSAGE, INPUT, TOOLS } from "./tools.js";

const schema = INPUT.duo_propose_decision;
const base = { title: "t", question: "q", answer: "a" };
const ok = (v: Record<string, unknown>) => schema.safeParse({ ...base, ...v }).success;

describe("duo_propose_decision input contract (H-71)", () => {
  it("accepts exactly the H-71 fields; evidence, source, extensions and kind stay rejected", () => {
    expect(Object.keys(schema.shape).sort()).toEqual(["agent", "answer", "enforcement", "forbids", "governs", "question", "rationale", "supersedes", "title"]);
    for (const extra of [{ evidence: [] }, { source: [] }, { extensions: {} }, { kind: "decision" }, { state: "confirmed" }, { lock: { digest: "sha256:x" } }]) expect(ok(extra)).toBe(false);
  });

  it("A an old-style request is still valid", () => {
    expect(ok({})).toBe(true);
    expect(ok({ rationale: "r", governs: { requirements: ["AUTH-01"], paths: ["src/**"] }, agent: "codex" })).toBe(true);
  });

  it("B/C forbids with enforcement block, and supersedes, are valid", () => {
    expect(ok({ forbids: { paths: ["src/ui/**"], symbols: ["*SessionStore*"], dependencies: ["left-pad"] }, enforcement: "block" })).toBe(true);
    expect(ok({ forbids: { symbols: ["*X*"] } })).toBe(true); // enforcement omitted stays omitted
    expect(ok({ supersedes: "D-001" })).toBe(true);
  });

  it("D/E forbids: a pattern review cannot compile is rejected; an empty forbids is rejected; no new syntax", () => {
    for (const p of ["../outside/**", "/etc/**", "C:\\x\\**", ""]) expect(ok({ forbids: { paths: [p] } }), p).toBe(false);
    expect(ok({ forbids: {} })).toBe(false);
    expect(ok({ forbids: { paths: [], symbols: [] } })).toBe(false);
    expect(ok({ forbids: { regex: ["x"] } })).toBe(false);
    expect(ok({ forbids: { paths: Array.from({ length: 101 }, (_, i) => `src/${i}`) } })).toBe(false);
  });

  it("F/G enforcement is warn or block only; supersedes is one Decision ID", () => {
    for (const e of ["error", "BLOCK", "", true]) expect(ok({ enforcement: e })).toBe(false);
    for (const id of ["P-001", "AUTH-01", "D-", "d-001", "D-001 ", ["D-001"]]) expect(ok({ supersedes: id })).toBe(false);
  });

  it("T35.2 forbids.symbols: qualified-name wildcards pass; a DUO path#symbol reference or a path is refused with an actionable message", () => {
    for (const s of ["LegacyDb", "LegacyDb.run", "*LegacyDb*", "Namespace::LegacyDb", "Legacy?b", "app.db.LegacyDb"]) expect(ok({ forbids: { symbols: [s] } }), s).toBe(true);
    for (const s of ["src/db/legacy-db.ts#LegacyDb", "src/db/LegacyDb", "LegacyDb#run", "src\\db\\LegacyDb"]) {
      const r = schema.safeParse({ ...base, forbids: { symbols: [s] } });
      expect(r.success, s).toBe(false);
      const message = r.success ? "" : r.error.issues.map((i) => i.message).join(" ");
      expect(message).toContain(FORBIDS_SYMBOL_MESSAGE);
      expect(message).toMatch(/'LegacyDb' or '\*LegacyDb\*'/u);
    }
    expect(TOOLS.duo_propose_decision.description).toMatch(/qualified names of changed symbols.*not a pattern and is refused.*not new calls or references/su);
  });

  it("O the tool list is unchanged: nine tools, no confirm or reject", () => {
    const names = Object.keys(TOOLS);
    expect(names).toHaveLength(9);
    expect(names.filter((n) => /confirm|reject|write|index|record/u.test(n))).toEqual([]);
    expect(TOOLS.duo_propose_decision.description).toMatch(/proposal only.*does not change any review verdict.*no authority until a human confirms/su);
  });
});
