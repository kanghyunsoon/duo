/**
 * duoctl ui server (T18.1): a local HTTP server that serves the bundled UI and a versioned JSON API
 * over the shared operations. It holds no Project Truth. Graph reads open the current graph
 * read-only and close it; local work activity is stored as regenerable runtime data.
 *
 * Security (docs/10-security.md): bound to 127.0.0.1; the Host header must name this server
 * (DNS rebinding); a per-run session token arrives once in the launch URL and becomes an HttpOnly,
 * SameSite=Strict cookie (never localStorage, Truth or metrics); every /api request needs it.
 * Mutations are POST only, need a same-origin Origin, application/json and a separate CSRF token that
 * only same-origin script can read (/api/session). Work activity is regenerable local runtime data.
 * No CORS headers. Assets are served from an allowlist held in memory (a request path never reaches
 * the filesystem). A strict CSP allows only this origin. Other UI writes are Decision confirm/reject
 * through DecisionService and regenerable work activity JSON.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry, isSecretFileName, readGitUserName, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService, DEFINITION_ID_PATTERN, fileRef, normalizeRepoPath, readSourceFile, STATE_DIR_NAME, type Diagnostic, type RepoPath } from "@duo-director/core";
import { appendRuntimeMetric, MAX_BUDGET, MIN_BUDGET, reviewLlmMetric, type ReviewResult, type TokenCountMemo } from "@duo-director/director";
import { z } from "zod";
import { LLMProviderPool } from "../llm/factory.js";
import { withGraphReader, type Operation } from "../operations/common.js";
import { projectContext } from "../operations/context.js";
import { projectGraphQuery } from "../operations/graph.js";
import { diffEnd, projectReview } from "../operations/review.js";
import { searchEvidence } from "../operations/search.js";
import { projectDecisionDetail, projectDecisionList } from "./decisions.js";
import { projectDirection, projectEntity, projectOverview, projectProposals, projectReviewHistory } from "./projection.js";
import { projectProposalPreview } from "./preview.js";
import { addWorkTask, completeWorkTask, expandWorkNode, listWorkTasks, projectWorkMap, workMapRevision } from "./work-map.js";

export const UI_API_VERSION = "1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SOURCE_LINES = 120;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
};
/** SPA routes that return index.html (deep links survive a refresh). */
const PAGES = /^\/(?:|overview|direction|graph|work|context|review|reviews(?:\/[\w.-]+)?|decisions|coverage|search|entity\/.+)$/u;

/** The bundled UI: dist/ui next to the published bundle, or packages/ui/dist/app in the workspace. */
export function locateUiAssets(): string | undefined {
  const candidates = [new URL("./ui/", import.meta.url), new URL("../../../ui/dist/app/", import.meta.url)].map((u) => fileURLToPath(u));
  return candidates.find((d) => fs.existsSync(path.join(d, "index.html")));
}

function loadAssets(dir: string): Map<string, { readonly type: string; readonly body: Buffer }> {
  const out = new Map<string, { type: string; body: Buffer }>();
  for (const name of fs.readdirSync(dir)) {
    const type = TYPES[path.extname(name).toLowerCase()];
    const file = path.join(dir, name);
    if (type === undefined || !fs.lstatSync(file).isFile() || name.endsWith(".map")) continue;
    out.set(name, { type, body: fs.readFileSync(file) });
  }
  return out;
}

export interface DuoUiServerOptions {
  readonly root: string;
  /** 0 or undefined: a free port chosen by the system. */
  readonly port?: number;
  readonly version: string;
  /** Tests: another asset directory. */
  readonly assetsDir?: string;
  /** Default: one pool over the environment at start (like MCP; restart for a new key). */
  readonly llm?: LLMProviderPool;
  readonly registry?: AnalyzerRegistry;
  readonly log?: (line: string) => void;
  readonly clock?: () => Date;
}

export interface DuoUiServer {
  readonly port: number;
  /** http://127.0.0.1:<port>/ */
  readonly origin: string;
  /** Opens a session (sets the cookie) and redirects to /overview. Print it; never persist it. */
  readonly launchUrl: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "UI_REQUEST_TOO_LARGE", "request body is too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "UI_REQUEST_INVALID", "request body is not JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "UI_REQUEST_INVALID", r.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
  return r.data;
}

const text = (max: number) => z.string().trim().min(1).max(max);
// eslint-disable-next-line no-control-regex -- control characters are refused on purpose
const endpoint = z.string().min(1).max(256).refine((v) => !v.startsWith("-") && !/[\u0000-\u001f\u007f\s]/u.test(v), "HEAD, INDEX, WORKTREE or a commit / branch name");
const PROPOSAL_ID = /^P-[A-Za-z0-9-]{1,64}$/u;
/** A Truth definition ID (D-001, or a Markdown Decision ID): letters, digits, dot, dash, underscore. */
const DEFINITION_ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const SCHEMAS = {
  context: z.strictObject({ task: text(20_000), budget: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).optional() }),
  review: z.strictObject({ task: text(20_000).optional(), from: endpoint.optional(), to: endpoint.optional(), includeSemanticAssist: z.boolean().optional() }),
  // previewDigest is required (T34.3): a UI confirm is always bound to the preview the person reviewed.
  confirm: z.strictObject({ confirmId: z.string().max(80), previewDigest: z.string().min(1).max(100) }),
  reject: z.strictObject({ reason: z.string().max(2000).optional() }),
  graph: z.strictObject({ node: text(4096), kind: z.enum(["trace", "impact"]).default("trace"), depth: z.coerce.number().int().min(1).max(3).default(1) }),
  search: z.strictObject({ q: text(200), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  source: z.strictObject({ path: text(4096), start: z.coerce.number().int().min(1), end: z.coerce.number().int().min(1) }),
  decisions: z.strictObject({ state: z.enum(["proposed", "confirmed", "superseded", "rejected"]).optional(), q: text(200).optional() }),
  workMap: z.strictObject({ selected: z.union([z.string().uuid(), z.string().regex(/^[0-9a-f]{32}$/u)]).optional() }),
  workExpand: z.strictObject({ node: text(4096), depth: z.coerce.number().int().min(1).max(3).default(1) }),
  workTask: z.strictObject({ agent: text(80), name: text(200), issueId: z.string().regex(DEFINITION_ID_PATTERN).optional() }),
  completeTask: z.strictObject({ id: z.union([z.string().uuid(), z.string().regex(/^[0-9a-f]{32}$/u)]) }),
} as const;

export async function startDuoUiServer(options: DuoUiServerOptions): Promise<DuoUiServer> {
  const assetsDir = options.assetsDir ?? locateUiAssets();
  if (assetsDir === undefined) throw new Error("the DUO UI assets are missing: reinstall the @duo-director/cli package");
  const assets = loadAssets(assetsDir);
  const index = assets.get("index.html");
  if (index === undefined) throw new Error(`${assetsDir} has no index.html`);
  const root = options.root;
  const log = options.log ?? (() => {});
  const session = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const llm = options.llm ?? new LLMProviderPool(process.env);
  const own = options.registry === undefined ? await createDefaultAnalyzerRegistry() : undefined;
  const registry = options.registry ?? own?.value;
  if (registry === undefined) throw new Error((own?.diagnostics ?? []).map((d) => d.message).join("; ") || "no analyzer registry");
  // One registry, one LLM pool and one in-memory token-count memo for the server's lifetime (TASK-019).
  const shared = { registry, llm, tokenCounts: new Map() as TokenCountMemo };
  const streams = new Set<http.ServerResponse>();
  let sequence = 0;
  const publish = (kind: "tasks-changed" | "repository-changed" | "graph-changed") => {
    const message = `data: ${JSON.stringify({ seq: ++sequence, kind })}\n\n`;
    for (const stream of streams) stream.write(message);
  };
  let port = 0;
  const cookieName = () => `duo_ui_${port}`;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const actor = async () => ({ kind: "human" as const, name: `ui:${(await readGitUserName(root)) ?? "human"}` });
  const now = options.clock ?? (() => new Date());

  const meter = async (command: string, status: string, started: number, extra: Record<string, unknown> = {}) => {
    const written = await appendRuntimeMetric(root, { format: "duo.metric/1", surface: "ui", command, status, exitCode: 0, durationMs: Date.now() - started, at: now().toISOString(), ...extra });
    for (const d of written.diagnostics) log(`duoctl ui: ${d.code}: ${d.message}`);
  };

  /** Operation → envelope data. not-initialized and domain states (index-required, BLOCK, …) are 200. */
  const data = (op: Operation<unknown>) => (op.kind === "ok" ? op.payload
    : op.kind === "not-initialized" ? { status: "not-initialized", message: "Not a DUO project yet: run duoctl init" }
      : { status: "failed", diagnostics: op.diagnostics.map((d: Diagnostic) => ({ code: d.code, message: d.message })) });

  async function api(req: http.IncomingMessage, url: URL): Promise<{ name: string; body: unknown }> {
    const method = req.method ?? "GET";
    const route = url.pathname.slice("/api/".length);
    const query = Object.fromEntries(url.searchParams);
    const only = (m: "GET" | "POST") => {
      if (method !== m) throw new HttpError(405, "UI_METHOD_NOT_ALLOWED", `${method} is not allowed on /api/${route}`);
    };
    // #77: the Decision detail and preview routes take no query, and the Decision list refuses a repeated name
    // instead of keeping its last value. Checked after the method, so Host, session, Origin/CSRF and 405 keep their
    // order. The messages are fixed and never echo a name or value.
    const noQuery = () => {
      if ([...url.searchParams.keys()].length > 0) throw new HttpError(400, "UI_REQUEST_INVALID", "this route takes no query parameters");
    };
    const noRepeatedQuery = () => {
      const names = [...url.searchParams.keys()];
      if (new Set(names).size !== names.length) throw new HttpError(400, "UI_REQUEST_INVALID", "a query parameter is repeated");
    };
    const confirmMatch = /^proposals\/([^/]+)\/(confirm|reject)$/u.exec(route);
    const previewMatch = /^proposals\/([^/]+)\/preview$/u.exec(route);
    if (previewMatch !== null) {
      only("GET");
      noQuery();
      let id: string;
      try {
        id = decodeURIComponent(previewMatch[1] as string);
      } catch {
        throw new HttpError(400, "UI_REQUEST_INVALID", "not a proposal ID");
      }
      if (!PROPOSAL_ID.test(id)) throw new HttpError(400, "UI_REQUEST_INVALID", "not a proposal ID");
      return { name: "preview", body: await projectProposalPreview(root, id) };
    }
    if (confirmMatch !== null) {
      only("POST");
      const id = decodeURIComponent(confirmMatch[1] as string);
      if (!PROPOSAL_ID.test(id)) throw new HttpError(400, "UI_REQUEST_INVALID", "not a proposal ID");
      const started = Date.now();
      const service = createDecisionService({ root, clock: now });
      if (confirmMatch[2] === "confirm") {
        const body = parse(SCHEMAS.confirm, await readJson(req));
        // The ID typed again: a guard against a misclick, not an authentication.
        if (body.confirmId.trim() !== id) throw new HttpError(400, "UI_CONFIRM_ID_MISMATCH", "type the proposal ID to confirm it");
        // Bound to the preview the person reviewed (T34.2, T34.3): a changed candidate is not confirmed.
        const r = await service.confirm(await actor(), id, { expectedDigest: body.previewDigest });
        await meter("decision", r.value === undefined ? "failed" : "confirmed", started);
        return { name: "decision", body: r.value === undefined ? { status: "failed", diagnostics: r.diagnostics.map((d) => ({ code: d.code, message: d.message })) } : { status: "confirmed", result: r.value, warnings: r.diagnostics.map((d) => ({ code: d.code, message: d.message })) } };
      }
      const body = parse(SCHEMAS.reject, await readJson(req));
      const r = await service.reject(await actor(), id, body.reason);
      await meter("decision", r.value === undefined ? "failed" : "rejected", started);
      return { name: "decision", body: r.value === undefined ? { status: "failed", diagnostics: r.diagnostics.map((d) => ({ code: d.code, message: d.message })) } : { status: "rejected", result: r.value } };
    }
    const entityMatch = /^entity\/(.+)$/u.exec(route);
    if (entityMatch !== null) {
      only("GET");
      const id = decodeURIComponent(entityMatch[1] as string);
      if (id.length > 4096) throw new HttpError(400, "UI_REQUEST_INVALID", "ID too long");
      return { name: "entity", body: data(await projectEntity(root, id, shared)) };
    }
    const decisionMatch = /^decisions\/([^/]+)$/u.exec(route);
    if (decisionMatch !== null) {
      only("GET");
      noQuery();
      let id: string;
      try {
        id = decodeURIComponent(decisionMatch[1] as string);
      } catch {
        throw new HttpError(400, "UI_REQUEST_INVALID", "not a Decision ID");
      }
      if (!DEFINITION_ID.test(id)) throw new HttpError(400, "UI_REQUEST_INVALID", "not a Decision ID");
      return { name: "decision-detail", body: data(await projectDecisionDetail(root, id)) };
    }
    const recordMatch = /^reviews\/(review-[0-9a-f]{16})$/u.exec(route);
    if (recordMatch !== null) {
      only("GET");
      const history = await projectReviewHistory(root);
      const records = (history.kind === "ok" ? (history.payload.records as { id: string }[]) : []);
      const record = records.find((r) => r.id === recordMatch[1]);
      return { name: "review-record", body: record === undefined ? { status: "not-found", id: recordMatch[1] } : { status: "found", record } };
    }
    switch (route) {
      case "session": only("GET"); return { name: "session", body: { csrf, version: options.version, apiVersion: UI_API_VERSION, root: path.basename(root) } };
      case "overview": only("GET"); return { name: "overview", body: data(await projectOverview(root, shared)) };
      case "direction": only("GET"); return { name: "direction", body: data(await projectDirection(root)) };
      case "proposals": only("GET"); return { name: "proposals", body: data(await projectProposals(root)) };
      case "decisions": {
        only("GET");
        noRepeatedQuery();
        const q = parse(SCHEMAS.decisions, query);
        return { name: "decisions", body: data(await projectDecisionList(root, { ...(q.state === undefined ? {} : { state: q.state }), ...(q.q === undefined ? {} : { q: q.q }) })) };
      }
      case "reviews": only("GET"); return { name: "reviews", body: data(await projectReviewHistory(root)) };
      case "graph": {
        only("GET");
        const q = parse(SCHEMAS.graph, query);
        return { name: "graph", body: data(await projectGraphQuery(root, q.kind, q.node, q.depth, shared)) };
      }
      case "work-map": {
        only("GET");
        const q = parse(SCHEMAS.workMap, query);
        return { name: "work-map", body: await projectWorkMap(root, q.selected, shared) };
      }
      case "work-revision": {
        only("GET");
        return { name: "work-revision", body: { revision: await workMapRevision(root) } };
      }
      case "work-expand": {
        only("GET");
        const q = parse(SCHEMAS.workExpand, query);
        return { name: "work-expand", body: await expandWorkNode(root, q.node, q.depth) };
      }
      case "work-tasks": {
        if (method === "GET") return { name: "work-tasks", body: { tasks: listWorkTasks(root) } };
        only("POST");
        const body = parse(SCHEMAS.workTask, await readJson(req));
        const task = addWorkTask(root, { agent: body.agent, name: body.name,
          ...(body.issueId === undefined ? {} : { issueId: body.issueId }) }, now());
        publish("tasks-changed");
        return { name: "work-tasks", body: { task } };
      }
      case "work-task-complete": {
        only("POST");
        const body = parse(SCHEMAS.completeTask, await readJson(req));
        const task = completeWorkTask(root, body.id, now());
        if (task === undefined) throw new HttpError(404, "UI_WORK_TASK_NOT_FOUND", "no such work task");
        publish("tasks-changed");
        return { name: "work-tasks", body: { task } };
      }
      case "search": {
        only("GET");
        const q = parse(SCHEMAS.search, query);
        return { name: "search", body: data(await searchEvidence(root, q.q, q.limit)) };
      }
      case "source": {
        only("GET");
        const q = parse(SCHEMAS.source, query);
        const p = normalizeRepoPath(q.path).value;
        if (p === undefined || q.end < q.start) throw new HttpError(400, "UI_REQUEST_INVALID", "a repository-relative path and a line range");
        if (isSecretFileName(p as RepoPath)) throw new HttpError(403, "UI_SOURCE_FORBIDDEN", "secret files are never shown");
        // Only files the index knows: the evidence viewer never becomes a file browser.
        const indexed = await withGraphReader(root, (graph) => Promise.resolve(graph.getNode(fileRef(p as RepoPath)) !== undefined));
        if (!indexed) throw new HttpError(404, "UI_SOURCE_NOT_INDEXED", "not an indexed file");
        const content = readSourceFile(root, p);
        if (content.value === undefined) throw new HttpError(404, "UI_SOURCE_UNREADABLE", "the file cannot be read as text");
        const lines = content.value.split("\n");
        const end = Math.min(q.end, q.start + MAX_SOURCE_LINES - 1, lines.length);
        return { name: "source", body: { path: p, start: q.start, end, truncated: end < q.end, lines: lines.slice(q.start - 1, end) } };
      }
      case "context": {
        only("POST");
        const body = parse(SCHEMAS.context, await readJson(req));
        const started = Date.now();
        const op = await projectContext(root, { task: body.task, ...(body.budget === undefined ? {} : { budget: body.budget }) }, shared);
        const p = op.kind === "ok" ? op.payload : undefined;
        await meter("context", p?.status ?? op.kind, started, { contextStatus: p?.status ?? op.kind, ...(p?.context.packet === undefined ? {} : { contextTokens: p.context.packet.metrics.budget.used, contextBudget: p.context.packet.metrics.budget.total }), llmCalls: 0 });
        return { name: "context", body: data(op) };
      }
      case "review": {
        only("POST");
        const body = parse(SCHEMAS.review, await readJson(req));
        const started = Date.now();
        const op = await projectReview(root, {
          diff: { from: body.from === undefined ? "HEAD" : diffEnd(body.from), to: body.to === undefined ? "WORKTREE" : diffEnd(body.to) },
          ...(body.task === undefined ? {} : { task: body.task }), ...(body.includeSemanticAssist === true ? { includeSemanticAssist: true } : {}),
        }, shared);
        const r = op.kind === "ok" ? (op.payload as ReviewResult) : undefined;
        await meter("review", r?.status ?? op.kind, started, r === undefined ? {} : { ...(r.verdict === undefined ? {} : { reviewVerdict: r.verdict }), reviewClaims: r.claims.length, ...reviewLlmMetric(r) });
        return { name: "review", body: data(op) };
      }
      default: throw new HttpError(404, "UI_NOT_FOUND", `no API route /api/${route}`);
    }
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const headers: Record<string, string> = {
      "Content-Security-Policy": CONTENT_SECURITY_POLICY, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
    };
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const fail = (e: HttpError) => sendJson(e.status, { format: "duo.ui.error/1", ok: false, error: { code: e.code, message: e.message } });
    void (async () => {
      try {
        if (!allowedHosts().has((req.headers.host ?? "").toLowerCase())) throw new HttpError(403, "UI_HOST_REJECTED", "this server only answers to 127.0.0.1 or localhost on its own port");
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) {
          const cookie = cookieValue(req.headers.cookie, cookieName());
          if (cookie === undefined || !equal(cookie, session)) throw new HttpError(401, "UI_SESSION_REQUIRED", "no UI session: open the URL printed by duoctl ui");
          if (url.pathname === "/api/work-events") {
            if (req.method !== "GET") throw new HttpError(405, "UI_METHOD_NOT_ALLOWED", "events require GET");
            res.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
            streams.add(res);
            res.write(`data: ${JSON.stringify({ seq: sequence, kind: "connected" })}\n\n`);
            req.on("close", () => streams.delete(res));
            return;
          }
          if (req.method !== "GET" && req.method !== "HEAD") {
            const origin = req.headers.origin;
            if (origin === undefined || !allowedOrigins().has(origin)) throw new HttpError(403, "UI_ORIGIN_REJECTED", "cross-origin requests are not accepted");
            if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "UI_CONTENT_TYPE", "send application/json");
            const token = req.headers["x-duo-csrf"];
            if (typeof token !== "string" || !equal(token, csrf)) throw new HttpError(403, "UI_CSRF_REJECTED", "missing or wrong CSRF token");
          }
          const { name, body } = await api(req, url);
          sendJson(200, { format: `duo.ui.${name}/${UI_API_VERSION}`, ok: true, data: body, meta: { durationMs: Date.now() - started } });
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "UI_METHOD_NOT_ALLOWED", "pages are GET only");
        const asset = /^\/assets\/([A-Za-z0-9._-]+)$/u.exec(url.pathname);
        if (asset !== null) {
          const file = asset[1] === "index.html" ? undefined : assets.get(asset[1] as string);
          if (file === undefined) throw new HttpError(404, "UI_NOT_FOUND", "no such asset");
          res.writeHead(200, { ...headers, "Content-Type": file.type, "Cache-Control": "no-cache" });
          res.end(req.method === "HEAD" ? undefined : file.body);
          return;
        }
        if (!PAGES.test(url.pathname)) throw new HttpError(404, "UI_NOT_FOUND", "no such page");
        const offered = url.searchParams.get("session");
        if (offered !== null) {
          if (!equal(offered, session)) throw new HttpError(403, "UI_SESSION_REJECTED", "this session link is not valid for this server run");
          const target = url.pathname === "/" ? "/overview" : url.pathname;
          res.writeHead(303, { ...headers, Location: target, "Set-Cookie": `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/`, "Cache-Control": "no-store" });
          res.end();
          return;
        }
        res.writeHead(200, { ...headers, "Content-Type": index.type, "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : index.body);
      } catch (error) {
        if (error instanceof HttpError) return fail(error);
        // The launch URL contains a session secret. Never include request URLs in logs.
        log(`duoctl ui: INTERNAL ${req.method ?? ""}: ${error instanceof Error ? error.message : String(error)}`);
        return fail(new HttpError(500, "UI_INTERNAL_ERROR", "unexpected server failure (details on the duoctl ui console)"));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  let watcher: fs.FSWatcher | undefined;
  let pending: NodeJS.Timeout | undefined;
  const taskFile = path.join(root, STATE_DIR_NAME, "runtime", "work-tasks.json");
  const taskFileChanged = (current: fs.Stats, previous: fs.Stats) => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) publish("tasks-changed");
  };
  // Atomic task writes can surface only the temporary filename through fs.watch on Windows.
  fs.watchFile(taskFile, { interval: 2000 }, taskFileChanged);
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      const file = String(filename ?? "").replaceAll("\\", "/");
      const taskWrite = file === `${STATE_DIR_NAME}/runtime/work-tasks.json` ||
        (file.startsWith(`${STATE_DIR_NAME}/runtime/work-tasks.json.`) && file.endsWith(".tmp"));
      if (file === "" || file === STATE_DIR_NAME || /^(?:\.git|node_modules|dist|\.dist)\//u.test(file) ||
        (file === `${STATE_DIR_NAME}/cache` || file.startsWith(`${STATE_DIR_NAME}/cache/`)) ||
        file === `${STATE_DIR_NAME}/runtime` ||
        (file.startsWith(`${STATE_DIR_NAME}/runtime/`) && !taskWrite)) return;
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(() => {
        publish(taskWrite ? "tasks-changed"
          : file.startsWith(`${STATE_DIR_NAME}/generated/`) ? "graph-changed" : "repository-changed");
      }, 250);
    });
    watcher.on("error", (error) => log(`duoctl ui: work watcher: ${error.message}`));
  } catch (error) { log(`duoctl ui: work watcher unavailable: ${(error as Error).message}`); }
  let finish = () => {};
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  server.once("close", () => { watcher?.close(); fs.unwatchFile(taskFile, taskFileChanged); if (pending !== undefined) clearTimeout(pending); own?.value?.dispose(); finish(); });
  const origin = `http://127.0.0.1:${port}`;
  return {
    port, origin, launchUrl: `${origin}/?session=${session}`, closed,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
