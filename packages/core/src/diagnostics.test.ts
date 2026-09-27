import { describe, expect, it } from "vitest";
import { canonicalDiagnostics, createDiagnostic, DIAGNOSTIC_PERSISTENCE, DIAGNOSTIC_SEVERITY, isPersistentDiagnostic, persistentDiagnostics } from "./diagnostics.js";

describe("diagnostic persistence (T08.1)", () => {
  it("classifies every code", () => {
    expect(Object.keys(DIAGNOSTIC_PERSISTENCE).sort()).toEqual(Object.keys(DIAGNOSTIC_SEVERITY).sort());
    for (const code of ["TSCONFIG_INVALID", "MODULE_AMBIGUOUS", "ANNOTATION_TARGET_UNKNOWN", "DECLARED_SYMBOL_UNRESOLVED", "PATH_PORTABILITY_COLLISION"] as const) {
      expect(DIAGNOSTIC_PERSISTENCE[code]).toBe("persistent");
    }
    for (const code of ["GRAPH_WRITE_REFUSED", "FILE_READ_ERROR", "GIT_COMMAND_FAILED", "INDEX_STATE_INVALID", "DECISION_LOCK_BUSY"] as const) {
      expect(DIAGNOSTIC_PERSISTENCE[code]).toBe("transient");
    }
  });

  it("orders canonically, drops exact duplicates and transient diagnostics", () => {
    const a = createDiagnostic("MODULE_UNRESOLVED", "x", { path: "src/b.ts", startLine: 2 });
    const b = createDiagnostic("TSCONFIG_INVALID", "y", { path: "tsconfig.json" });
    const c = createDiagnostic("MODULE_UNRESOLVED", "w", { path: "src/b.ts", startLine: 2 });
    const t = createDiagnostic("GRAPH_WRITE_REFUSED", "busy");
    expect(isPersistentDiagnostic(t)).toBe(false);
    expect(canonicalDiagnostics([b, a, c, a])).toEqual([t, c, a, b].filter((d) => d !== t));
    expect(persistentDiagnostics([t, b, a, c])).toEqual(persistentDiagnostics([c, a, b, a]));
  });
});

