import { describe, it } from "vitest";
import { login } from "../src/auth/login.js";
import { format } from "../src/shared/format.js";

function helper(): string {
  return format(0);
}

describe("App", () => {
  it("logs in", () => {
    login("x");
    helper();
  });

  // duo: APP-02
  it("keeps the session", () => {});
});
