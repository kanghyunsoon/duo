import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDecisionService } from "../decisions/service.js";
import { requireCompleteTruth, truthAuthorityErrors } from "./authority.js";
import { loadProjectTruth } from "./project.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const LOCKED = "id: D-001\ntitle: Stateless auth\nkind: decision\nstate: confirmed\nquestion: session_state\nanswer: no server session store\nforbids:\n  symbols: [\"*SessionStore*\"]\nenforcement: block\n";

function repo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-authority-")));
  temps.push(root);
  const all: Record<string, string> = { ".duo-project/project.yaml": "schema_version: 1\nname: authority\n", ...files };
  for (const [f, t] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  }
  return root;
}
// Truth and history only: the lifecycle's lock directory under runtime/ is regenerable state, not a Truth write.
const snapshot = (root: string) => fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => !/[\\/]runtime([\\/]|$)/u.test(f)).sort().map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), "utf8") : "<dir>"]);

describe("T40 N1: authoritative operations never decide on partial Project Truth", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["unknown top-level field on a confirmed block Decision", { ".duo-project/decisions/D-001.yaml": LOCKED + "future_rule:\n  calls: [LegacyDb.run]\n" }, "SCHEMA_UNKNOWN_PROPERTY"],
    ["malformed YAML", { ".duo-project/decisions/D-001.yaml": LOCKED + "forbids: [unclosed\n" }, "YAML_SYNTAX_ERROR"],
    ["wrong type", { ".duo-project/decisions/D-001.yaml": LOCKED.replace("enforcement: block", "enforcement: 5") }, "SCHEMA_INVALID_VALUE"],
    ["unknown forbids property (a later or misspelled field)", { ".duo-project/decisions/D-001.yaml": LOCKED.replace("forbids:\n", "forbids:\n  imported_pathz: [src/db/**]\n") }, "SCHEMA_UNKNOWN_PROPERTY"],
    ["broken proposal schema", { ".duo-project/decisions/proposals/P-001.yaml": "id: P-001\ntitle: x\nstate: proposed\nquestion: q\nanswer: a\nbogus: 1\n" }, "SCHEMA_UNKNOWN_PROPERTY"],
  ];
  for (const [name, files, code] of cases) {
    it(`${name}: the loader still reads what it can, the authority boundary refuses with the file named`, () => {
      const root = repo(files);
      const loaded = loadProjectTruth(root);
      expect(loaded.value).toBeDefined(); // tolerant loader contract unchanged
      expect(loaded.diagnostics.map((d) => d.code)).toContain(code);
      const r = requireCompleteTruth(loaded);
      expect(r.value).toBeUndefined();
      expect(r.diagnostics[0]?.code).toBe("PROJECT_TRUTH_INVALID");
      const offending = Object.keys(files)[0] ?? "";
      expect(r.diagnostics[0]?.message).toContain(offending);
      expect(r.diagnostics.slice(1).some((d) => d.code === code && d.source?.path === offending)).toBe(true);
    });
  }

  it("before the boundary the omission was silent: the invalid confirmed Decision is just not in the Truth", () => {
    const loaded = loadProjectTruth(repo({ ".duo-project/decisions/D-001.yaml": LOCKED + "future_rule: x\n" }));
    expect(loaded.value?.truth.decisions.map((d) => d.id)).toEqual([]);
  });

  it("reference-integrity errors keep every definition and do not block", () => {
    const root = repo({ ".duo-project/decisions/D-001.yaml": LOCKED.replace("enforcement: block", "enforcement: block\ngoverns:\n  requirements: [AUTH-99]") });
    const loaded = loadProjectTruth(root);
    expect(loaded.diagnostics.map((d) => d.code)).toEqual(["BROKEN_REFERENCE"]);
    expect(truthAuthorityErrors(loaded.diagnostics)).toEqual([]);
    expect(requireCompleteTruth(loaded).value?.truth.decisions.map((d) => d.id)).toEqual(["D-001"]);
  });

  it("the Decision lifecycle refuses preview, confirm and reject on partial Truth and writes nothing", async () => {
    const root = repo({
      ".duo-project/decisions/D-001.yaml": LOCKED + "future_rule: x\n",
      ".duo-project/decisions/proposals/P-001.yaml": "id: P-001\ntitle: Passkeys\nstate: proposed\nquestion: login\nanswer: passkey\n",
    });
    const before = snapshot(root);
    const service = createDecisionService({ root });
    const human = { kind: "human" as const, name: "Ada" };
    for (const r of [await service.previewConfirm("P-001"), await service.confirm(human, "P-001"), await service.reject(human, "P-001")]) {
      expect(r.value).toBeUndefined();
      expect(r.diagnostics[0]?.code).toBe("PROJECT_TRUTH_INVALID");
    }
    expect(snapshot(root)).toEqual(before);
    // A proposal has no authority: an agent can still propose (for example the fix); its confirm stays refused.
    const proposed = await service.propose({ kind: "agent", name: "codex" }, { title: "Fix", question: "q2", answer: "a2" });
    expect(proposed.value?.proposalId).toBe("P-002");
    expect((await service.confirm(human, "P-002")).diagnostics[0]?.code).toBe("PROJECT_TRUTH_INVALID");
  });
});
