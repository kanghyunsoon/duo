/** Player inventory with stackable items and weight limits. */
export interface Item {
  id: string;
  name: string;
  weight: number;
  stack: number;
  maxStack: number;
}

export class Inventory {
  private readonly items = new Map<string, Item>();

  constructor(readonly capacity: number) {}

  /** Total carried weight. */
  weight(): number {
    let total = 0;
    for (const item of this.items.values()) total += item.weight * item.stack;
    return total;
  }

  /** Adds items; returns how many did not fit. */
  add(item: Item, count: number): number {
    let left = count;
    const existing = this.items.get(item.id);
    const room = Math.floor((this.capacity - this.weight()) / item.weight);
    const accepted = Math.min(left, room, item.maxStack - (existing?.stack ?? 0));
    if (accepted <= 0) return left;
    this.items.set(item.id, { ...item, stack: (existing?.stack ?? 0) + accepted });
    left -= accepted;
    return left;
  }

  /** Removes items; returns how many were removed. */
  remove(itemId: string, count: number): number {
    const existing = this.items.get(itemId);
    if (existing === undefined) return 0;
    const removed = Math.min(count, existing.stack);
    if (removed === existing.stack) this.items.delete(itemId);
    else this.items.set(itemId, { ...existing, stack: existing.stack - removed });
    return removed;
  }

  has(itemId: string, count = 1): boolean {
    return (this.items.get(itemId)?.stack ?? 0) >= count;
  }

  list(): Item[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Moves items to another inventory as far as it has room. */
  transfer(itemId: string, count: number, target: Inventory): number {
    const item = this.items.get(itemId);
    if (item === undefined) return 0;
    const wanted = Math.min(count, item.stack);
    const refused = target.add({ ...item, stack: 0 }, wanted);
    const moved = wanted - refused;
    this.remove(itemId, moved);
    return moved;
  }
}

/** Crafting: consumes ingredients and produces one item when all are present. */
export function craft(inventory: Inventory, recipe: { ingredients: [string, number][]; result: Item }): boolean {
  if (!recipe.ingredients.every(([id, n]) => inventory.has(id, n))) return false;
  for (const [id, n] of recipe.ingredients) inventory.remove(id, n);
  return inventory.add(recipe.result, 1) === 0;
}
