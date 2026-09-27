import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_ID_PATTERN, ENTITY_TYPES, fileRef, isDefinitionId, nodeId, parseNodeId, PROJECT_REF, symbolRef, testRef,
} from "./ids.js";
import { normalizeRepoPath, type RepoPath } from "./paths.js";

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

describe("node ID contract", () => {
  const src = normalizeRepoPath("src\\auth\\AuthService.ts").value as RepoPath;

  it("builds the same node ID for a file on every OS", () => {
    expect(nodeId(fileRef(src))).toBe("file:src/auth/AuthService.ts");
    expect(nodeId(symbolRef(src, "AuthService.refresh"))).toBe("sym:src/auth/AuthService.ts#AuthService.refresh");
    expect(nodeId(testRef(src, "AuthService > refresh"))).toBe("test:src/auth/AuthService.ts#AuthService > refresh");
    expect(nodeId({ type: "requirement", id: "AUTH-03" })).toBe("req:AUTH-03");
    expect(nodeId(PROJECT_REF)).toBe("project:root");
  });

  it("round-trips every entity type", () => {
    for (const type of ENTITY_TYPES) {
      const ref = { type, id: type === "file" ? "src/a.ts" : "X-1" };
      expect(parseNodeId(nodeId(ref))).toEqual(ref);
    }
    expect(parseNodeId("nope:1")).toBeUndefined();
    expect(parseNodeId("req:")).toBeUndefined();
  });
});
