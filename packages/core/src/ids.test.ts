import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_ID_PATTERN, isDefinitionId, nodeId, parseNodeId, type EntityRef } from "./ids.js";
import { normalizeRepoPath } from "./paths.js";

interface NodeIdFixture {
  cases: { name: string; input?: string; ref: EntityRef; nodeId: string }[];
  invalid: string[];
}
const fixture = JSON.parse(fs.readFileSync(new URL("../../../fixtures/core/node-ids.json", import.meta.url), "utf8")) as NodeIdFixture;

describe("definition IDs", () => {
  it.each(["AUTH-03", "REQ-CONTEXT-001", "D-004", "ADR-005", "TASK-012A", "GAME-42", "CON-001", "M1"])("accepts %s", (id) => {
    expect(isDefinitionId(id)).toBe(true);
  });

  it.each(["auth-03", "REQ_CONTEXT_001", "TASK-12AB", "ADR-", "M", "-1", "REQ-CONTEXT-001 ", "P-20260927-k3f9qa"])("rejects %j", (id) => {
    expect(isDefinitionId(id)).toBe(false);
  });

  it("recognises acceptance criterion IDs", () => {
    expect(["AC-010-02", "AC-012A-01"].every((id) => ACCEPTANCE_ID_PATTERN.test(id))).toBe(true);
    expect(["AC-10-2", "AC-010-2", "ac-010-02"].some((id) => ACCEPTANCE_ID_PATTERN.test(id))).toBe(false);
  });
});

describe("node ID contract (fixtures/core/node-ids.json)", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s: nodeId and parseNodeId round-trip", (_name, c) => {
    if (c.input !== undefined && "path" in c.ref) expect(normalizeRepoPath(c.input).value).toBe(c.ref.path);
    expect(nodeId(c.ref)).toBe(c.nodeId);
    expect(parseNodeId(c.nodeId)).toEqual(c.ref);
    expect(nodeId(parseNodeId(nodeId(c.ref)) as EntityRef)).toBe(c.nodeId);
  });

  it("keeps NFC and NFD spellings as different IDs", () => {
    const ids = fixture.cases.filter((c) => c.name.startsWith("Unicode N")).map((c) => c.nodeId);
    expect(new Set(ids).size).toBe(2);
  });

  it.each(fixture.invalid)("rejects %j", (value) => {
    expect(parseNodeId(value)).toBeUndefined();
  });
});
