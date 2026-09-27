/**
 * contentHash: DUO's cross-platform working-tree fingerprint (TASK-004).
 *
 * - text: CRLF (0x0D 0x0A) becomes LF, then SHA-256. Nothing else changes: no Unicode
 *   normalization, trimming, BOM removal, case or whitespace changes, and a lone CR stays.
 *   The same content checked out with different EOLs gets the same hash.
 * - binary: SHA-256 of the raw bytes.
 *
 * The work is done on bytes, so text is never decoded and re-encoded.
 */
import { createHash } from "node:crypto";
import type { FileContentKind } from "./content-kind.js";

export const CONTENT_HASH_PREFIX = "sha256:";

/** The bytes that are hashed: text with CRLF → LF, binary unchanged. */
export function canonicalContent(bytes: Uint8Array, kind: FileContentKind): Uint8Array {
  if (kind === "binary") return bytes;
  let pairs = 0;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) pairs++;
  if (pairs === 0) return bytes;
  const out = new Uint8Array(bytes.length - pairs);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[j++] = bytes[i] ?? 0;
  }
  return out;
}

export interface ContentHash {
  /** "sha256:" + 64 lowercase hex digits of the canonical content. */
  readonly contentHash: string;
  /** Byte length of the canonical content (the same on every OS). */
  readonly size: number;
}

export function computeContentHash(bytes: Uint8Array, kind: FileContentKind): ContentHash {
  const canonical = canonicalContent(bytes, kind);
  return { contentHash: CONTENT_HASH_PREFIX + createHash("sha256").update(canonical).digest("hex"), size: canonical.length };
}
