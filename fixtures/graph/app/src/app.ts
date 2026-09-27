// duo: APP-02
import { login } from "./auth/index.js";
import { login as runLogin } from "./auth/login.js";
import * as Auth from "./auth/index.js";
import createSession, { Session } from "./auth/session.js";
import { format } from "@shared/format.js";
import { util } from "./util/index.js";
import { deep } from "./chain/a.js";
import { deep as nearDeep } from "./chain/near.js";
import leftPad from "left-pad";
import { missing } from "./missing.js";

export function main(user: string): void {
  login(user);
  runLogin(user);
  Auth.login(user);
  createSession();
  const s = new Session();
  Session.load();
  s.save();
  format(1);
  util();
  deep();
  nearDeep();
  leftPad("x");
  missing();
}
