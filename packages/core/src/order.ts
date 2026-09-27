/**
 * Deterministic ordering (T04). Every place that needs a stable order (GraphStore, traverse,
 * scanner, fingerprint output, diagnostics) uses compareUtf8: UTF-8 byte-lexicographic order.
 *
 * UTF-8 byte order equals Unicode code point order and SQLite's BINARY collation. JavaScript's
 * default string comparison (`<`, `Array#sort()`) compares UTF-16 code units instead, which puts
 * supplementary characters (emoji, U+10000 and above) before U+E000..U+FFFF. compareUtf8 fixes that
 * without encoding: at the first differing code unit, surrogates are ranked above U+E000..U+FFFF.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return rank(x) < rank(y) ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/** Maps UTF-16 code units so that their numeric order is code point order. */
function rank(unit: number): number {
  if (unit < 0xd800) return unit;
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
}
