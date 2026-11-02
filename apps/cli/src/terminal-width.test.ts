import { describe, expect, it } from "vitest";
import { columns, padColumns } from "./terminal-width.js";

describe("terminal column alignment", () => {
  it("keeps the CLI's existing width rules for Korean setup labels", () => {
    for (const label of ["저장소", "Truth", "Index", "Baseline", "완료", "이미 있음", "조치 필요"]) {
      expect(columns(padColumns(label, 12))).toBeGreaterThanOrEqual(12);
    }
    expect(columns("저장소")).toBe(6);
    expect(columns("Baseline")).toBe(8);
  });
});
