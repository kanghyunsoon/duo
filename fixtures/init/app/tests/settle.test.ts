import { describe, expect, it } from "vitest";
import { balances } from "../src/settle.js";

describe("balances", () => {
  it("splits an expense evenly", () => {
    expect(balances([{ payer: "a", cents: 100, sharedBy: ["a", "b"] }]).get("b")).toBe(-50);
  });
});
