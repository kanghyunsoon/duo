/** Canonical peer ID: trimmed, lower case. */
export function normalize(peer: string): string {
  return peer.trim().toLowerCase();
}
