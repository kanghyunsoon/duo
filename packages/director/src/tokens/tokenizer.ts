/**
 * Official token measurement (ADR-005, TASK-010): o200k_base, implemented by gpt-tokenizer (pure
 * JavaScript, no native build, deterministic). Every official token value in DUO comes from here;
 * the library is imported nowhere else (lint rule, scripts/boundaries.json "tokenizer").
 *
 * Special-token text such as "<|endoftext|>" in repository content is measured as ordinary text:
 * DUO counts what it would send, it never emits control tokens.
 */
import { decode, encode } from "gpt-tokenizer/encoding/o200k_base";

/** The official estimator. version is the exact library version pinned in package.json (checked by a test). */
export const TOKEN_ESTIMATOR = { name: "o200k_base", library: "gpt-tokenizer", version: "4.0.0" } as const;

export type TokenEstimatorName = typeof TOKEN_ESTIMATOR.name;

/** Estimator identity for cache keys and digests: a different library version may count differently. */
export const TOKEN_ESTIMATOR_ID = `${TOKEN_ESTIMATOR.name}@${TOKEN_ESTIMATOR.library}@${TOKEN_ESTIMATOR.version}`;

const PLAIN_TEXT = { disallowedSpecial: new Set<string>() };

/** o200k_base token count of text. */
export function countTokens(text: string): number {
  return text.length === 0 ? 0 : encode(text, PLAIN_TEXT).length;
}

/** A token value always travels with its estimator and the provider-independent sizes (AC-010-06). */
export interface TextMeasure {
  readonly tokens: number;
  readonly estimator: TokenEstimatorName;
  /** UTF-8 bytes. */
  readonly bytes: number;
  /** Unicode code points. */
  readonly chars: number;
}

export function measureText(text: string): TextMeasure {
  return { tokens: countTokens(text), estimator: TOKEN_ESTIMATOR.name, bytes: Buffer.byteLength(text, "utf8"), chars: codePoints(text) };
}

export function codePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff || i + 1 >= text.length) n++;
    else {
      const d = text.charCodeAt(i + 1);
      n++;
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return n;
}

/** The first maxTokens tokens of text (a prefix of the text; a split multi-byte character is dropped). */
export function truncateToTokens(text: string, maxTokens: number): { readonly text: string; readonly truncated: boolean } {
  const tokens = encode(text, PLAIN_TEXT);
  if (tokens.length <= maxTokens) return { text, truncated: false };
  return { text: decode(tokens.slice(0, Math.max(0, maxTokens))).replace(/\uFFFD+$/u, ""), truncated: true };
}

/**
 * UI-only rough estimate when no tokenizer value exists yet (ADR-005: "approx (chars/4)"). Never
 * used for a budget decision or an official metric.
 */
export function approximateTokens(text: string): { readonly tokens: number; readonly estimator: "approx (chars/4)" } {
  return { tokens: Math.ceil(codePoints(text) / 4), estimator: "approx (chars/4)" };
}
