import { AuthService } from "./auth/AuthService.js";
import { TokenStore } from "./auth/token-store.js";
import { Matchmaker } from "./lobby/matchmaker.js";
import { loadConfig } from "./util/config.js";

/** Wires the services together. */
export function main(): void {
  const config = loadConfig();
  const auth = new AuthService(new TokenStore(), new Map());
  const lobby = new Matchmaker();
  void auth;
  void lobby;
  process.stdout.write(`listening on ${config.port}\n`);
}
