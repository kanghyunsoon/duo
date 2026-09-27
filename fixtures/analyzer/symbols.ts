// Symbols fixture (TASK-005). Tests check positions: keep the layout.
import type { Clock } from "./clock";

export interface Session {
  id: string;
}

export type SessionId = string;

export enum Role {
  Admin,
  User,
}

const TIMEOUT = 5000;

export const Login = () => {
  return TIMEOUT;
};

export let legacy = function () {
  function nested() {}
  return nested;
};

export function parse(x: string): string;
export function parse(x: number): number;
export function parse(x: unknown) {
  return x;
}

export declare function declared(): void;

export abstract class Base {
  abstract run(): void;
}

export class AuthService extends Base {
  static instances = 0;
  #token = "";

  constructor(private readonly clock: Clock) {
    super();
  }

  get token(): string {
    return this.#token;
  }

  set token(value: string) {
    this.#token = value;
  }

  static create(): AuthService {
    return new AuthService({ now: () => 0 });
  }

  login(user: string): boolean;
  login(user: string, remember: boolean): boolean;
  login(user: string, remember?: boolean): boolean {
    return this.#refresh(user, remember ?? false);
  }

  #refresh(user: string, remember: boolean): boolean {
    return user.length > 0 && remember;
  }

  run(): void {}

  "quoted-name"(): void {}

  [Symbol.iterator](): void {}
}

class Internal {}

export { Internal };
