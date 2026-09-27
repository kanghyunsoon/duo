import { describe, expect, it } from "vitest";
import { buildReport } from "./build-report.js";

describe("buildReport", () => {
  it("sums whole euros", () => {
    expect(buildReport([{ userId: "a", cents: 250 }]).total).toBe(2);
  });
});
