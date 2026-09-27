import { compareUtf8 } from "@duo-director/core";
import { GraphStoreError, type JsonObject, type JsonValue } from "./types.js";

function canonical(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GraphStoreError("INVALID_INPUT", `${path}: ${value} is not a finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => canonical(v, `${path}[${i}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareUtf8)) out[key] = canonical((value as Record<string, unknown>)[key], `${path}.${key}`);
    return out;
  }
  throw new GraphStoreError("INVALID_INPUT", `${path}: ${typeof value} is not a JSON value`);
}

/** Canonical JSON: keys in UTF-8 byte order (core compareUtf8), finite numbers only. Same input gives the same bytes. */
export function canonicalJson(value: JsonObject | undefined, path: string): string {
  return JSON.stringify(canonical(value ?? {}, path));
}
