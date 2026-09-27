/**
 * Packet cache (TASK-010): .duo-project/cache/packets/<digest>.json. Regenerable data (ADR-006,
 * write boundary "regenerable"). A Packet is reused only under its exact Packet Dependency Digest;
 * a missing, unreadable or foreign entry is a miss, and a miss only costs time: the Compiler then
 * builds the same Packet. Writing is opt-in (compileContext cache option).
 */
import fs from "node:fs";
import path from "node:path";
import { checkWriteBoundary, STATE_DIR_NAME } from "@duo-director/core";
import type { ContextPacket } from "./types.js";

export const PACKET_CACHE_DIR = `${STATE_DIR_NAME}/cache/packets`;
const FORMAT = "duo.packet-cache/1";

function fileOf(digest: string): string {
  return `${PACKET_CACHE_DIR}/${digest.replace(/^sha256:/u, "")}.json`;
}

export function readCachedPacket(root: string, digest: string): ContextPacket | undefined {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return undefined;
  try {
    const target = path.join(root, fileOf(digest));
    if (fs.lstatSync(target).isSymbolicLink()) return undefined;
    const entry = JSON.parse(fs.readFileSync(target, "utf8")) as { format?: unknown; digest?: unknown; packet?: ContextPacket };
    if (entry.format !== FORMAT || entry.digest !== digest || entry.packet?.dependencyDigest !== digest || entry.packet.format !== "duo.context-packet/1") return undefined;
    return entry.packet;
  } catch {
    return undefined;
  }
}

/** Writes an entry atomically (temp file + rename). Returns false when the write was refused or failed. */
export function writeCachedPacket(root: string, packet: ContextPacket): boolean {
  const allowed = checkWriteBoundary(root, fileOf(packet.dependencyDigest), "regenerable");
  if (allowed.value === undefined) return false;
  const target = path.join(root, allowed.value.path);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ format: FORMAT, digest: packet.dependencyDigest, packet }));
    fs.renameSync(temp, target);
    return true;
  } catch {
    fs.rmSync(temp, { force: true });
    return false;
  }
}
