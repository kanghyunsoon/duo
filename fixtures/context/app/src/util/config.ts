export interface ServerConfig {
  port: number;
  tokenIssuer: string;
}

/** Reads the server configuration from the environment. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return { port: Number(env.PORT ?? 8080), tokenIssuer: env.TOKEN_ISSUER ?? "duo-game" };
}
