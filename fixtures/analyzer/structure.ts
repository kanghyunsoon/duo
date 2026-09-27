import { helper } from "./helper";
import * as Auth from "./auth";

export default class Foo {
  save() {
    this.validate();
    const inner = function () {
      this.validate();
    };
    const arrow = () => this.validate();
    helper();
  }

  validate() {}
}

function a(helper: () => void) {
  helper();
}

function outer() {
  const local = () => {};
  local();
  Auth.login();
  helper();
}

export { a as renamed, outer };
export const value = 1, fn = () => {};
export interface T {}
export type U = string;
