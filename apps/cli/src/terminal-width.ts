/** Terminal columns for the wide characters recognized by the CLI's alignment logic. */
export function columns(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1;
  return n;
}

export function padColumns(s: string, width: number): string {
  return s + " ".repeat(Math.max(1, width - columns(s)));
}
