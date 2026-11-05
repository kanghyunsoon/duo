import type { ConfirmPreview } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { previewLines } from "./decision.js";

const base = {
  sourceId: "P-001", sourceKind: "proposal", sourcePath: ".duo-project/decisions/proposals/P-001.yaml", action: "create", proposalId: "P-001",
  expectedDecisionId: "D-001", nextDecisionId: "D-001", digest: "sha256:x", proposedBy: "codex", proposedByKind: "agent",
} as const;

describe("informed confirm preview: forbids scope (T40 N3)", () => {
  it("states that forbids are repository-wide right under Forbids, whatever governs says", () => {
    const lines = previewLines("en", { ...base, candidate: { title: "t", question: "q", answer: "a", governs: { paths: ["src/ui/**"] }, forbids: { imported_paths: ["src/db/legacy-db.ts"] }, enforcement: "block" } } as unknown as ConfirmPreview, "confirm");
    const i = lines.findIndex((l) => l.trimStart().startsWith("Forbids "));
    expect(lines[i]).toContain("imported_paths: src/db/legacy-db.ts");
    expect(lines[i + 1]).toMatch(/^ {2}Forbids scope +repository-wide \(governs does not narrow forbids\)$/u);
    expect(previewLines("ko", { ...base, candidate: { title: "t", question: "q", answer: "a", forbids: { paths: ["x/**"] } } } as unknown as ConfirmPreview, "confirm").join("\n")).toContain("저장소 전체");
  });

  it("shows no scope row when nothing is forbidden", () => {
    const lines = previewLines("en", { ...base, candidate: { title: "t", question: "q", answer: "a", governs: { paths: ["src/ui/**"] } } } as unknown as ConfirmPreview, "confirm");
    expect(lines.some((l) => l.includes("Forbids scope"))).toBe(false);
  });
});

describe("informed confirm preview: literal brackets (H-104 Q3)", () => {
  it("says that [ and ] are literal when a governs or forbids path pattern has one, and only then", () => {
    const preview = (candidate: Record<string, unknown>, L: "en" | "ko" = "en") =>
      previewLines(L, { ...base, candidate: { title: "t", question: "q", answer: "a", ...candidate } } as unknown as ConfirmPreview, "confirm");
    expect(preview({ forbids: { paths: ["app/[id]/**"] } })).toContainEqual(expect.stringMatching(/^ {2}Brackets +"\[" and "\]" are literal characters: app\/\[id\]\/\*\* matches a directory named \[id\]/u));
    expect(preview({ governs: { paths: ["app/[id]/page.tsx"] } }).some((l) => l.trimStart().startsWith("Brackets "))).toBe(true);
    expect(preview({ forbids: { imported_paths: ["src/[legacy]/db.ts"] } }, "ko").join("\n")).toContain("문자 그대로");
    expect(preview({ governs: { paths: ["src/ui/**"] }, forbids: { symbols: ["[x]"] } }).some((l) => l.includes("Brackets"))).toBe(false);
  });
});
