import { signAccessToken, verifyAccessToken } from "./jwt.js";
import { TokenStore } from "./token-store.js";
import { audit } from "../util/log.js";

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/** Authentication entry point used by the HTTP layer. */
export class AuthService {
  constructor(private readonly store: TokenStore, private readonly users: Map<string, string>) {}

  /** Checks the password and opens a session. */
  login(email: string, password: string): Session {
    const expected = this.users.get(email);
    if (expected === undefined || expected !== password) throw new Error("invalid credentials");
    const refreshToken = this.store.issue(email);
    audit("login", email);
    return { userId: email, accessToken: signAccessToken(email), refreshToken };
  }

  /**
   * Exchanges a refresh token for a new access token.
   * Unknown or revoked tokens are rejected.
   */
  refresh(refreshToken: string): Session {
    const userId = this.store.lookup(refreshToken);
    if (userId === undefined) throw new Error("unknown refresh token");
    const next = this.store.rotate(refreshToken);
    audit("refresh", userId);
    return { userId, accessToken: signAccessToken(userId), refreshToken: next };
  }

  /** Ends every session of the user. */
  logout(accessToken: string): void {
    const userId = verifyAccessToken(accessToken);
    this.store.revokeAll(userId);
    audit("logout", userId);
  }
}
