export class Session {
  static load(): Session {
    return new Session();
  }

  save(): void {
    this.validate();
  }

  validate(): void {}
}

export default function createSession(): Session {
  return Session.load();
}
