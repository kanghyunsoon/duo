/**
 * T16.1 test server: the real duo-director MCP server (built packages/integration) over stdio, with
 * two operations replaced through the test injection point. The tool list and schemas are unchanged.
 *   duo_get_context waits until its AbortSignal fires, then records "aborted" (cancellation test).
 *   duo_trace throws an unexpected exception (failure isolation test).
 * Usage: node fake-server.mjs <repository root> <marker file>
 */
import fs from "node:fs";
import { serveDuoMcp } from "../../packages/integration/dist/index.js";

const [root, marker] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(marker, line + "\n");

const served = await serveDuoMcp({
  root, version: "0.0.0-test",
  toolOverrides: {
    duo_get_context: (_args, ctx) => new Promise((resolve) => {
      note("started");
      const done = () => { note(ctx.signal.reason?.name === "AbortError" || ctx.signal.aborted ? "aborted" : "finished"); resolve({ op: { kind: "failed", diagnostics: [] } }); };
      if (ctx.signal.aborted) done();
      else ctx.signal.addEventListener("abort", done, { once: true });
    }),
    duo_trace: async () => { throw new Error("boom: unexpected failure inside an operation"); },
  },
});
if (served.value === undefined) {
  process.stderr.write(JSON.stringify(served.diagnostics) + "\n");
  process.exit(1);
}
await served.value.closed;
