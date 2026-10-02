import { describe, expect, it } from "vitest";
import { ambiguityRemediation } from "./remediation.js";
import type { SeedAmbiguity } from "./types.js";

const sym = (ref: string) => ({ id: "sym:" + ref, ref, kind: "symbol", title: ref.slice(ref.indexOf("#") + 1) });
const amb = (refs: string[], reason: SeedAmbiguity["reason"] = "symbol-name"): SeedAmbiguity => ({ term: "run", reason, options: refs.map(sym) });

describe("ambiguity remediation (T26.2): only handles the seed resolver accepts", () => {
  it("a path is suggested only when every candidate is in its own file and each path is one path token", () => {
    expect(ambiguityRemediation(amb(["src/a.ts#run", "src/b.ts#run"])).handles).toEqual(["path"]);
    // A file at the repository root has no "/": the task cannot name it as a path (a leading ./ is stripped too).
    expect(ambiguityRemediation(amb(["main.ts#run", "src/b.ts#run"])).handles).toEqual([]);
    expect(ambiguityRemediation(amb(["src/my file.ts#run", "src/b.ts#run"])).handles).toEqual([]);
  });

  it("a qualified name is suggested only when the names differ and read as names, not IDs", () => {
    expect(ambiguityRemediation(amb(["src/a.ts#A.run", "src/a.ts#B.run"])).handles).toEqual(["qualified-name"]);
    expect(ambiguityRemediation(amb(["src/a.ts#A.run", "src/b.ts#B.run"]))).toMatchObject({ handles: ["path", "qualified-name"], definitionIdAlso: true });
    expect(ambiguityRemediation(amb(["src/a.ts#AB-12", "src/a.ts#CD-34"])).handles).toEqual([]);
  });

  it("Requirement ties name an ID; nothing that does not tell the candidates apart is suggested", () => {
    const tie: SeedAmbiguity = { term: "export", reason: "keyword-tie", options: [{ id: "req:TIE-01", ref: "TIE-01", kind: "requirement" }, { id: "req:TIE-02", ref: "TIE-02", kind: "requirement" }] };
    expect(ambiguityRemediation(tie)).toMatchObject({ handles: ["definition-id"], definitionIdAlso: false });
    expect(ambiguityRemediation(amb(["src/a.ts#A.run", "src/a.ts#B.run", "src/b.ts#A.run"]))).toMatchObject({ handles: [], definitionIdAlso: false });
  });
});
