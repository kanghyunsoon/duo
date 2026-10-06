/**
 * T37 (H-72) lock compatibility: forbids.imported_paths enters the lock digest only when it has a value,
 * so a Decision without it keeps the digest it had before T37. The expected values below were computed
 * with the pre-T37 code (next 8822c20) and must never change.
 */
import { describe, expect, it } from "vitest";
import { parseDecisionFile } from "../domain/files.js";
import { decisionLockDigest, verifyDecisionLock } from "./digest.js";

const PRE_T37 = {
  full: ["id: D-001\ntitle: Stateless auth\nkind: decision\nstate: proposed\nquestion: session_state\nanswer: tokens are verified without a server-side session store\nrationale: scale out\ngoverns:\n  requirements: [AUTH-01]\n  paths: [src/auth/**]\nforbids:\n  symbols: [\"*SessionStore*\"]\n  paths: [src/legacy/**]\n  dependencies: [express-session]\nenforcement: block\n",
    "sha256:01c10897858c5415c385ac7a570d6e74b94eef52e777ff10b5467453fc5c8eba"],
  minimal: ["id: D-002\ntitle: Minutes only\nstate: proposed\nquestion: duration_unit\nanswer: minutes\n", "sha256:e2c2573ff641000c8d3fad1c7b150746ce37bd40d3f896f1232db2efceb58426"],
  emptyForbids: ["id: D-003\ntitle: Empty forbids\nstate: proposed\nquestion: q3\nanswer: a3\nforbids: {}\n", "sha256:fcf452eb7ae8d7a2401350092d398b9a2610d67fe64824d8ca32c9638bccd524"],
} as const satisfies Record<string, readonly [string, string]>;
const parse = (text: string) => {
  const d = parseDecisionFile(".duo-project/decisions/D-001.yaml", text);
  if (d.value === undefined) throw new Error(JSON.stringify(d.diagnostics));
  return d.value;
};

describe("T37 lock digest compatibility (H-72)", () => {
  it("a Decision without imported_paths keeps its pre-T37 digest; no empty default is injected", () => {
    for (const [name, [text, digest]] of Object.entries(PRE_T37)) {
      const d = parse(text);
      expect(decisionLockDigest(d), name).toBe(digest);
      expect("importedPaths" in d.forbids, name).toBe(false);
    }
    // An explicitly empty list is no value: the digest stays the pre-T37 one.
    expect(decisionLockDigest(parse(PRE_T37.full[0].replace("  dependencies: [express-session]\n", "  dependencies: [express-session]\n  imported_paths: []\n")))).toBe(PRE_T37.full[1]);
  });

  it("imported_paths with a value is locked content: it changes the digest, and editing it after confirm is a lock mismatch", () => {
    const withImports = PRE_T37.full[0].replace("  dependencies: [express-session]\n", "  dependencies: [express-session]\n  imported_paths: [src/legacy/db.ts]\n");
    const d = parse(withImports);
    expect(d.forbids.importedPaths).toEqual(["src/legacy/db.ts"]);
    const digest = decisionLockDigest(d);
    expect(digest).not.toBe(PRE_T37.full[1]);
    const confirmed = withImports.replace("state: proposed", "state: confirmed") + `lock:\n  digest: "${digest}"\n`;
    expect(verifyDecisionLock(parse(confirmed)).value.status).toBe("valid");
    const edited = confirmed.replace("imported_paths: [src/legacy/db.ts]", "imported_paths: [src/legacy/other.ts]");
    expect(verifyDecisionLock(parse(edited)).value.status).toBe("mismatch");
  });
});
