import { describe, expect, it } from "vitest";
import { TokenService } from "./token-service.js";

describe("TokenService", () => {
  it("refresh returns a new access token", () => {
    const service = new TokenService("s");
    expect(service.refresh("u.2000.x", 1000)).toContain("u.");
  });
});
