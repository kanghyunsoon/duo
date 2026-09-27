export interface UsageRow {
  userId: string;
  cents: number;
}

/** Report totals in whole euros, rounded down. */
export function buildReport(rows: readonly UsageRow[]): { total: number } {
  const cents = rows.reduce((sum, r) => sum + r.cents, 0);
  return { total: Math.floor(cents / 100) };
}
