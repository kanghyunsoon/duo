import { describe, expect, it } from "vitest";
import { changedRows, matchesSelection, parseSelection } from "./decision-session.js";

const pending = ["P-001", "P-002", "P-003"];

describe("review-pending selection (T44)", () => {
  it("empty or ended input cancels; nothing is chosen by default", () => {
    expect(parseSelection(undefined, pending)).toEqual({ kind: "cancel" });
    expect(parseSelection("   ", pending)).toEqual({ kind: "cancel" });
    expect(parseSelection("cancel", pending)).toEqual({ kind: "cancel" });
  });
  it("all, one and IDs (any case or separator, returned in ID order)", () => {
    expect(parseSelection("ALL", pending)).toEqual({ kind: "all" });
    expect(parseSelection("one", pending)).toEqual({ kind: "one" });
    expect(parseSelection("p-003, P-001", pending)).toEqual({ kind: "ids", ids: ["P-001", "P-003"] });
  });
  it("unknown, duplicate and mixed answers are errors", () => {
    expect(parseSelection("P-001 P-009", pending)).toEqual({ kind: "error", reason: "unknown-id", id: "P-009" });
    expect(parseSelection("P-001 p-001", pending)).toEqual({ kind: "error", reason: "duplicate-id", id: "P-001" });
    expect(parseSelection("all P-001", pending)).toEqual({ kind: "error", reason: "mixed" });
    expect(parseSelection("yes", pending)).toEqual({ kind: "error", reason: "unknown-id", id: "yes" });
  });
  it("the final retype must be the chosen IDs in the order shown", () => {
    expect(matchesSelection("P-001 P-003", ["P-001", "P-003"])).toBe(true);
    expect(matchesSelection("p-001,p-003", ["P-001", "P-003"])).toBe(true);
    expect(matchesSelection("P-003 P-001", ["P-001", "P-003"])).toBe(false);
    expect(matchesSelection("P-001", ["P-001", "P-003"])).toBe(false);
    expect(matchesSelection("all", ["P-001", "P-003"])).toBe(false);
  });
  it("changedRows lists the rows that differ, without the Expected ID row", () => {
    const a = ["Confirm P-002: x", "  Title         t", "  Stale         no", "  Expected ID   D-002", "  File          f"];
    const b = ["Confirm P-002: x", "  Title         t", "  Stale         yes, changed", "  Expected ID   D-003", "  File          f"];
    expect(changedRows(a, b)).toEqual(["  - Stale         no", "  + Stale         yes, changed"]);
    expect(changedRows(a, a)).toEqual([]);
  });
});
