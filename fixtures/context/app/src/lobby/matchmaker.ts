import { Room } from "./room.js";

/** Fills rooms from a queue in arrival order. */
export class Matchmaker {
  private readonly queue: string[] = [];
  private rooms = 0;

  enqueue(playerId: string): void {
    this.queue.push(playerId);
  }

  /** Starts as many full rooms as the queue allows. */
  fill(): Room[] {
    const started: Room[] = [];
    let room = new Room(`room-${this.rooms + 1}`);
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined || !room.add(next)) break;
      if (room.isFull()) {
        started.push(room);
        this.rooms++;
        room = new Room(`room-${this.rooms + 1}`);
      }
    }
    return started;
  }
}
