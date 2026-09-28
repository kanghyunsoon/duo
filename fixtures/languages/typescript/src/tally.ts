import { normalize } from "./normalize.js";

export function tally(votes: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of votes) out.set(normalize(v), (out.get(normalize(v)) ?? 0) + 1);
  return out;
}
