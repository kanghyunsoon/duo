export interface Expense {
  readonly payer: string;
  readonly cents: number;
  readonly sharedBy: readonly string[];
}

/** Adds an expense to the ledger. */
export function addExpense(ledger: Expense[], expense: Expense): Expense[] {
  return [...ledger, expense];
}
