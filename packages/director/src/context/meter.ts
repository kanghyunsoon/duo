import { performance } from "node:perf_hooks";
import { countTokens } from "../tokens/index.js";

/** countTokens with a per-compile memo and a stopwatch (tokenization time is reported separately). */
export class TokenMeter {
  ms = 0;
  private readonly memo = new Map<string, number>();

  count(text: string): number {
    const hit = this.memo.get(text);
    if (hit !== undefined) return hit;
    const t0 = performance.now();
    const n = countTokens(text);
    this.ms += performance.now() - t0;
    if (text.length <= 4096) this.memo.set(text, n);
    return n;
  }
}
