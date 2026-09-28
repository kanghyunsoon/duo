import { price } from "./price.js";

export function cartTotal(items: readonly number[]): number {
  return items.reduce((sum, i) => sum + price(i), 0);
}
