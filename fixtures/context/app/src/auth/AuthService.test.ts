import { describe, expect, it } from "vitest";
import { AuthService } from "./AuthService.js";
import { TokenStore } from "./token-store.js";

describe("AuthService", () => {
  it("login returns a session", () => {
    const service = new AuthService(new TokenStore(), new Map([["a@example.com", "pw"]]));
    expect(service.login("a@example.com", "pw").userId).toBe("a@example.com");
  });

  it("refresh returns a new access token", () => {
    const service = new AuthService(new TokenStore(), new Map([["a@example.com", "pw"]]));
    const session = service.login("a@example.com", "pw");
    expect(service.refresh(session.refreshToken).accessToken).not.toBe("");
  });
});
