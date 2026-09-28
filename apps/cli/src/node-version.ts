/**
 * The Node.js gate (T17.1): checked by the executable before anything else is loaded, so an old Node
 * gets a clear message instead of a failure deep inside (node:sqlite, ES2024 APIs). Only ">=x.y.z"
 * ranges are used by DUO's engines field.
 */
export function nodeVersionProblem(current: string, range: string): string | undefined {
  const want = /^>=\s*(\d+)\.(\d+)\.(\d+)$/u.exec(range.trim());
  const have = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(current);
  if (want === null || have === null) return undefined;
  const a = have.slice(1, 4).map(Number);
  const b = want.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) > (b[i] as number)) return undefined;
    if ((a[i] as number) < (b[i] as number)) {
      return `duoctl requires Node.js ${range.trim()} (this is ${current}). Install a supported Node.js release; DUO does not bundle Node.js.`;
    }
  }
  return undefined;
}
