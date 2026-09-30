// T21 instrumentation (not loaded by CI or pnpm test unless asked):
//   NODE_OPTIONS=--import=./bench/experiments/undici-trace.mjs
// Logs every fetch (Node's bundled undici) to 127.0.0.1 as one JSON line on stderr: method, path, which socket,
// whether the socket was reused, how long it had been idle since its previous response, and the outcome.
// Used to prove the ECONNRESET cause of the RC UI conformance test on Windows CI (T21-A).
import dc from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

const sockets = new WeakMap(); // socket → { id, served, lastDoneAt }
const requests = new WeakMap(); // request → { socket info, reused, idleMs, startedAt }
let nextSocket = 1;
const local = (req) => typeof req.origin === "string" ? req.origin.includes("127.0.0.1") : String(req.origin ?? "").includes("127.0.0.1");
const emit = (o) => process.stderr.write("[undici-trace] " + JSON.stringify(o) + "\n");

dc.subscribe("undici:client:connected", ({ socket }) => { sockets.set(socket, { id: nextSocket++, served: 0, lastDoneAt: undefined }); });
dc.subscribe("undici:client:sendHeaders", ({ request, socket }) => {
  if (!local(request)) return;
  const s = sockets.get(socket) ?? { id: -1, served: 0 };
  const now = performance.now();
  requests.set(request, { s, reused: s.served > 0, idleMs: s.lastDoneAt === undefined ? null : Math.round(now - s.lastDoneAt), startedAt: now });
});
dc.subscribe("undici:request:trailers", ({ request }) => {
  const r = requests.get(request);
  if (r === undefined) return;
  r.s.served++;
  r.s.lastDoneAt = performance.now();
  emit({ ok: true, method: request.method, path: request.path, socket: r.s.id, reused: r.reused, idleMs: r.idleMs, ms: Math.round(performance.now() - r.startedAt) });
});
dc.subscribe("undici:request:error", ({ request, error }) => {
  if (!local(request)) return;
  const r = requests.get(request);
  emit({ ok: false, method: request.method, path: request.path, socket: r?.s.id ?? null, reused: r?.reused ?? null, idleMs: r?.idleMs ?? null, error: error?.code ?? error?.name ?? String(error) });
});

