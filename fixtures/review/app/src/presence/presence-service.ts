/** Who is in which room. */
export class PresenceService {
  private readonly rooms = new Map<string, Set<string>>();

  join(userId: string, room: string): number {
    const members = this.rooms.get(room) ?? new Set<string>();
    members.add(userId);
    this.rooms.set(room, members);
    return members.size;
  }
}
