import { randomBytes } from "node:crypto";

/** Opaque refresh tokens, kept on the server so they can be revoked. */
export class TokenStore {
  private readonly owners = new Map<string, string>();

  /** Creates a refresh token for the user. */
  issue(userId: string): string {
    const token = randomBytes(24).toString("hex");
    this.owners.set(token, userId);
    return token;
  }

  lookup(token: string): string | undefined {
    return this.owners.get(token);
  }

  /** Replaces a refresh token with a new one for the same user. */
  rotate(token: string): string {
    const userId = this.owners.get(token);
    if (userId === undefined) throw new Error("unknown refresh token");
    this.owners.delete(token);
    return this.issue(userId);
  }

  revokeAll(userId: string): void {
    for (const [token, owner] of this.owners) if (owner === userId) this.owners.delete(token);
  }
}
