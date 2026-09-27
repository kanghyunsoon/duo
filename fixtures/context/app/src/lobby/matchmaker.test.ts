import { describe, expect, it } from "vitest";
import { Matchmaker } from "./matchmaker.js";

describe("Matchmaker", () => {
  it("fills a room with eight players", () => {
    const m = new Matchmaker();
    for (let i = 0; i < 8; i++) m.enqueue(`p${i}`);
    expect(m.fill()).toHaveLength(1);
  });
});
