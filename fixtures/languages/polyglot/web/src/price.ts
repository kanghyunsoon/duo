export function price(cents: number): number {
  return Math.round(cents) / 100;
}
