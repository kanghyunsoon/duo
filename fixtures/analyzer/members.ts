export class User {
  static load() {}
  load() {}

  static get name() { return "User"; }
  get name() { return this.n; }
  set name(v: string) { this.n = v; }

  static #count() {}
  #count() {}

  "a.b"() {}
  static "a.b"() {}
  static "load"() {}
}
