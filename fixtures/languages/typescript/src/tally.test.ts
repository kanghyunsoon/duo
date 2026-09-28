import { expect, it } from "vitest";
import { tally } from "./tally.js";

it("counts votes", () => {
  expect(tally(["a", "A "]).get("a")).toBe(2);
});
