import { normalize } from "./normalize.js";

export interface Transport {
  send(peer: string, data: string): void;
}

/** Realtime sessions of one server node. */
export class SessionServer {
  private readonly peers = new Set<string>();

  constructor(private readonly transport: Transport) {}

  connect(peer: string): void {
    this.peers.add(normalize(peer));
  }

  /** Sends a state update to every connected peer. */
  broadcast(message: string): number {
    for (const peer of this.peers) this.transport.send(peer, message);
    return this.peers.size;
  }
}
