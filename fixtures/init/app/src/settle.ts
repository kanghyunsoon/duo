import type { Expense } from "./ledger.js";

/** Net balance per person in cents (positive: is owed money). */
export function balances(ledger: readonly Expense[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of ledger) {
    const share = Math.floor(e.cents / e.sharedBy.length);
    out.set(e.payer, (out.get(e.payer) ?? 0) + e.cents);
    for (const p of e.sharedBy) out.set(p, (out.get(p) ?? 0) - share);
  }
  return out;
}
