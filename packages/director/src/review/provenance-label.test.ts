import { describe, expect, it } from "vitest";
import type { ViolationProvenance } from "../adoption/types.js";
import { PROVENANCE_LABELS, provenanceLabel } from "./provenance-label.js";

const VALUES: readonly ViolationProvenance[] = ["introduced", "pre-existing", "pre-existing-touched", "unverified-at-adoption"];

describe("human provenance wording (H-73, C240)", () => {
  it("B-E: each machine value has the adoption-baseline wording", () => {
    expect(VALUES.map((v) => provenanceLabel(v))).toEqual(["not-in-adoption-baseline", "in-adoption-baseline", "in-adoption-baseline, touched", "baseline-unverified"]);
  });

  it("ko translates the meaning, not the enum string", () => {
    expect(VALUES.map((v) => provenanceLabel(v, "ko"))).toEqual(["채택 기준선에 없음", "채택 기준선에 존재", "채택 기준선에 존재, 이번 변경에서 접촉", "채택 시점 검증 불가"]);
  });

  it("no label claims a time in the current diff or repeats a machine value", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const v of VALUES) {
        const label = PROVENANCE_LABELS[locale][v];
        expect(label).not.toMatch(/introduc|pre-existing|unverified-at-adoption|\bnew\b|added|created|신규|새로/iu);
      }
    }
    expect(new Set(VALUES.map((v) => provenanceLabel(v))).size).toBe(VALUES.length);
  });
});
