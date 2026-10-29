import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoPrivatePathsInEvidence, assessTable, atomicWriteJson, compareFocusSequence, hasUnverifiedFindings, runAuditLifecycle, sanitizeAuditArtifact, serializeAuditError, storeAuditRecord } from "./ui-a11y-artifacts.js";

const tempDirs: string[] = [];
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-a11y-artifacts-")); tempDirs.push(dir); return dir; }
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("UI accessibility audit artifacts", () => {
  it("checks persisted JSON and JSONL recursively and rejects malformed or missing evidence", () => {
    const dir = tempDir();
    const summary = path.join(dir, "summary.json");
    const cases = path.join(dir, "cases.jsonl");
    const root = path.join(dir, "RepoRoot");
    const home = path.join(dir, "HomeRoot");
    atomicWriteJson(summary, { nested: [{ text: "clean relative/path" }] });
    fs.writeFileSync(cases, `${JSON.stringify({ nested: ["clean", `prefix ${root}/private.ts`] })}\n`);
    expect(() => assertNoPrivatePathsInEvidence(summary, cases, root, home)).toThrow(/Private path/u);
    fs.writeFileSync(cases, `${JSON.stringify({ path: "c:\\USERS\\HOME\\secret" })}\n`);
    expect(() => assertNoPrivatePathsInEvidence(summary, cases, "C:/repo", "C:/Users/Home" )).toThrow(/Private path/u);
    fs.writeFileSync(cases, `${JSON.stringify({ path: "prefix C:/USERS/HOME/private.ts" })}\n`);
    expect(() => assertNoPrivatePathsInEvidence(summary, cases, "C:/repo", "C:/Users/Home")).toThrow(/Private path/u);
    fs.writeFileSync(cases, `${JSON.stringify({ paths: ["C:\\temp\\file", `prefix ${root}/private.ts`] })}\n`);
    expect(() => assertNoPrivatePathsInEvidence(summary, cases, root, home)).toThrow(/Private path/u);
    fs.writeFileSync(cases, `${JSON.stringify({ path: "relative/file.ts" })}\n{broken}\n`);
    expect(() => assertNoPrivatePathsInEvidence(summary, cases, "C:/repo", "C:/Users/Home")).toThrow();
    expect(() => assertNoPrivatePathsInEvidence(path.join(dir, "missing.json"), cases, root, home)).toThrow();
  });
  it("removes private paths, git details, and nested error text from shareable output", () => {
    const secret = "C:\\Users\\private\\repo\\secret.ts /home/private/repo/secret.ts \\\\server\\private";
    const artifact = sanitizeAuditArtifact({ cwd: secret, gitStatus: secret, id: "case", error: { name: "Error", message: secret, stack: secret, cause: { message: secret }, errors: [secret] }, detail: "fixture result" }) as Record<string, unknown>;
    expect(JSON.stringify(artifact)).not.toContain("private");
    expect(artifact).toMatchObject({ id: "case", error: { name: "Error", message: "[redacted]" }, detail: "fixture result" });
  });
  it("preserves nested, aggregate and cyclic errors with bounded strings", () => {
    const root = new Error("root");
    const aggregate = new AggregateError([new Error("child"), root], "aggregate", { cause: root });
    (root as Error & { cause?: unknown }).cause = aggregate;
    const serialized = serializeAuditError(aggregate);
    expect(serialized.message).toBe("aggregate");
    expect(serialized.errors).toHaveLength(2);
    expect(JSON.stringify(serialized)).toContain("circular");

    const longError = new Error("x".repeat(5_000));
    const bounded = serializeAuditError(longError);
    expect(bounded.message.length).toBeLessThanOrEqual(4_097);
    expect(bounded.truncated).toBe(true);
    const longStack = new Error("stack");
    longStack.stack = "s".repeat(20_000);
    expect(serializeAuditError(longStack).stack?.length).toBeLessThanOrEqual(16_385);
    const deepRoot = new Error("depth-0");
    let deep = deepRoot;
    for (let index = 1; index < 12; index++) { const next = new Error(`depth-${index}`); (deep as Error & { cause?: unknown }).cause = next; deep = next; }
    expect(JSON.stringify(serializeAuditError(deepRoot))).toContain("maximum error depth");
    const manyErrors = new AggregateError(Array.from({ length: 40 }, (_, index) => new Error(`child-${index}`)), "many");
    const serializedMany = serializeAuditError(manyErrors);
    expect(serializedMany.errors).toHaveLength(32);
    expect(serializedMany.truncated).toBe(true);
  });

  it("rejects duplicate case IDs and keeps the prior JSON intact on a failed write", () => {
    const dir = tempDir();
    const record = { id: "case-one", status: "통과" as const };
    const ids = new Set<string>();
    storeAuditRecord(dir, record, ids);
    const file = path.join(dir, "case-one", "result.json");
    const before = fs.readFileSync(file, "utf8");
    expect(() => storeAuditRecord(dir, record, ids)).toThrow(/Duplicate/u);
    expect(() => atomicWriteJson(file, BigInt(1))).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("retries pre-return execution errors and keeps the first attempt evidence", async () => {
    const evidence: string[] = [];
    let calls = 0;
    const lifecycle = await runAuditLifecycle({
      run: async (attemptIndex) => { calls++; evidence.push(`attempt-${attemptIndex}-partial`); if (attemptIndex === 1) throw new Error("capture failed after evidence"); return { status: "통과" }; },
      cleanup: async () => [],
    });
    expect(calls).toBe(2);
    expect(evidence).toEqual(["attempt-1-partial", "attempt-2-partial"]);
    expect(lifecycle.result?.status).toBe("통과");
    expect(lifecycle.attempts).toHaveLength(1);
    expect(lifecycle.toolErrors).toEqual([]);
  });

  it("keeps an earlier cleanup error when a retry returns a result", async () => {
    const lifecycle = await runAuditLifecycle({
      run: async (attemptIndex) => {
        if (attemptIndex === 1) throw new Error("first attempt failed");
        return { status: "통과" };
      },
      cleanup: async (attemptIndex) => attemptIndex === 1
        ? [{ phase: "context.close", error: serializeAuditError(new Error("context remained open")) }]
        : [],
    });
    expect(lifecycle.result?.status).toBe("통과");
    expect(lifecycle.attempts).toHaveLength(1);
    expect(lifecycle.toolErrors).toMatchObject([{ phase: "context.close" }]);
  });

  it("still cleans resources when error evidence capture itself fails", async () => {
    let cleaned = 0;
    const lifecycle = await runAuditLifecycle({
      run: async (attemptIndex) => { if (attemptIndex === 1) throw new Error("first run"); return { status: "통과" }; },
      onError: () => { throw new Error("screenshot failed"); },
      cleanup: async () => { cleaned++; return []; },
    });
    expect(cleaned).toBe(2);
    expect(lifecycle.result?.status).toBe("통과");
    expect(lifecycle.attempts[0]?.cleanupErrors?.[0]?.phase).toBe("error-evidence");
  });

  it("does not retry a returned product finding when cleanup fails", async () => {
    let calls = 0;
    const lifecycle = await runAuditLifecycle({
      run: async () => { calls++; return { status: "제품 문제", findings: ["focus was not restored"] }; },
      cleanup: async () => [{ phase: "context.close", error: serializeAuditError(new Error("close failed")) }],
    });
    expect(calls).toBe(1);
    expect(lifecycle.result?.status).toBe("제품 문제");
    expect(lifecycle.result?.findings).toEqual(["focus was not restored"]);
    expect(lifecycle.toolErrors).toHaveLength(1);
  });

  it("accepts simple th tables and detects small missing headers and invalid headers references", () => {
    expect(assessTable({ complex: false, headerIds: [], cells: [{ headers: [], hasRowHeader: false, hasColumnHeader: true }] }).missingHeaders).toBe(false);
    expect(assessTable({ complex: false, headerIds: [], cells: [{ headers: [], hasRowHeader: false, hasColumnHeader: false }] }).missingHeaders).toBe(true);
    expect(assessTable({ complex: false, headerIds: [], cells: [
      { headers: [], hasRowHeader: false, hasColumnHeader: true },
      { headers: [], hasRowHeader: false, hasColumnHeader: false },
    ] }).missingHeaders).toBe(true);
    expect(assessTable({ complex: false, headerIds: ["name", "status"], cells: [{ headers: ["name", "status"], hasRowHeader: false, hasColumnHeader: false }] }).missingHeaders).toBe(false);
    expect(assessTable({ complex: false, headerIds: ["name"], cells: [{ headers: ["missing"], hasRowHeader: false, hasColumnHeader: false }] }).missingHeaders).toBe(true);
    expect(assessTable({ role: "presentation", complex: false, headerIds: [], cells: [{ headers: [], hasRowHeader: false, hasColumnHeader: false }] })).toMatchObject({ kind: "presentation", missingHeaders: false });
    expect(assessTable({ complex: true, headerIds: ["group"], cells: [{ headers: [], hasRowHeader: false, hasColumnHeader: true }] }).kind).toBe("complex");
  });

  it("compares the full expected focus order and rejects missing, unexpected, duplicated, reordered and trapped targets", () => {
    const expected = ["skip", "nav:overview", "nav:search"];
    expect(compareFocusSequence(expected, expected).pass).toBe(true);
    const invalidSequences = [
      ["skip", "nav:overview"],
      ["skip", "extra", "nav:overview", "nav:search"],
      ["skip", "nav:overview", "nav:overview", "nav:search"],
      ["skip", "nav:search", "nav:overview"],
      ["skip", "nav:overview", "nav:overview", "nav:overview"],
    ];
    for (const actual of invalidSequences) {
      expect(compareFocusSequence(expected, actual).pass).toBe(false);
    }
  });

  it("keeps manual verification pending when the case status is a product problem", () => {
    expect(hasUnverifiedFindings({ findings: [
      { status: "제품 문제", detail: "Focus was not restored" },
      { status: "미검증", detail: "Screenshot still needs review" },
    ] })).toBe(true);
  });
});
