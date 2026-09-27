/** Collapses whitespace in a display name. */
export function normalize(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}
