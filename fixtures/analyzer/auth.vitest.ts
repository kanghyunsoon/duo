import { describe, it as spec, test } from "vitest";
import * as vt from "vitest";

describe("Auth", () => {
  describe("Refresh", () => {
    spec("expires", () => {});
    test.skip("renews", () => {});
  });
  it.only("not imported here", () => {});
  test.only("focused", () => {});
  test.todo("later");
  test(makeName(), () => {});
  test(`user ${id}`, () => {});
  test(`static template`, () => {});
});

describe(dynamicSuite(), () => {
  test("hidden by dynamic suite", () => {});
});

vt.it("through namespace", () => {});

export function registerTests() {
  test("registered", () => {});
}
