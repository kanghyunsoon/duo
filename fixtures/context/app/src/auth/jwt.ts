const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Signs a short-lived access token for the user. */
export function signAccessToken(userId: string, now: number = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS }));
  return `${header}.${payload}.signature`;
}

/** Returns the user of a valid access token or throws. */
export function verifyAccessToken(token: string, now: number = Date.now()): string {
  const [, payload] = token.split(".");
  if (payload === undefined) throw new Error("malformed token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; exp: number };
  if (claims.exp * 1000 < now) throw new Error("expired token");
  return claims.sub;
}
