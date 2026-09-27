/** Trims and lower-cases a display name for comparisons. */
export function normalize(name: string): string {
  return name.trim().toLowerCase();
}
