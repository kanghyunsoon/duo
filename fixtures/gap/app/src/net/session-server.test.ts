import { describe, expect, it } from "vitest";
import { SessionServer } from "./session-server.js";

describe("SessionServer", () => {
  it("broadcasts to connected peers", () => {
    const sent: string[] = [];
    const server = new SessionServer({ send: (peer) => sent.push(peer) });
    server.connect(" A ");
    expect(server.broadcast("tick")).toBe(1);
  });
});
