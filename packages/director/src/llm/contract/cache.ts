/**
 * LLM response cache (T13): .duo-project/cache/llm/<key>.json, regenerable, separate from the
 * Context Packet cache (cache/packets/). The key is the digest of the provider's cacheIdentity()
 * (who answers: provider, model, relevant settings), purpose, instructions, input, output spec
 * and output token limit. No identity, no cache. Only successful, validated answers are stored.
 */
import fs from "node:fs";
import path from "node:path";
import { checkWriteBoundary, sha256Text, stableJson, STATE_DIR_NAME } from "@duo-director/core";
import type { LLMRequest, LLMResponse } from "./types.js";

export const LLM_CACHE_DIR = `${STATE_DIR_NAME}/cache/llm`;
const FORMAT = "duo.llm-cache/1";

export function responseCacheKey(identity: string, request: LLMRequest): string {
  return sha256Text(stableJson({
    format: FORMAT, identity, purpose: request.purpose, instructions: request.instructions, input: request.input,
    output: request.output, maxOutputTokens: request.maxOutputTokens ?? null,
  }));
}

const fileOf = (key: string) => `${LLM_CACHE_DIR}/${key.replace(/^sha256:/u, "")}.json`;

export function readCachedResponse(root: string, key: string): LLMResponse | undefined {
  try {
    const target = path.join(root, fileOf(key));
    if (fs.lstatSync(target).isSymbolicLink()) return undefined;
    const entry = JSON.parse(fs.readFileSync(target, "utf8")) as { format?: unknown; key?: unknown; response?: LLMResponse };
    return entry.format === FORMAT && entry.key === key && entry.response?.status === "success" ? entry.response : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedResponse(root: string, key: string, response: LLMResponse): void {
  const allowed = checkWriteBoundary(root, fileOf(key), "regenerable");
  if (allowed.value === undefined) return;
  const target = path.join(root, allowed.value.path);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ format: FORMAT, key, response }));
    fs.renameSync(temp, target);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}
