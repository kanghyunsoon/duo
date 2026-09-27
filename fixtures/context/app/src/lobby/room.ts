export const MAX_PLAYERS = 8;

/** A match room. */
export class Room {
  readonly players: string[] = [];

  constructor(readonly id: string) {}

  /** Adds a player; false when the room is full. */
  add(playerId: string): boolean {
    if (this.isFull()) return false;
    this.players.push(playerId);
    return true;
  }

  isFull(): boolean {
    return this.players.length >= MAX_PLAYERS;
  }
}
