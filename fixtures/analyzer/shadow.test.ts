import { it } from "./my-it";

function test(name: string) {
  return name;
}

it("imported from a helper", () => {});
test("local function");
describe("global describe still counts", () => {});
