/**
 * UI API client (T18.1). The session is an HttpOnly cookie set by the launch URL; this module never
 * sees it. The CSRF token for POST comes from /api/session and lives only in memory (never storage).
 * HTTP errors are transport problems; Domain states (index-required, BLOCK, not-initialized) arrive as
 * normal 200 data.
 */
export interface Envelope<T> {
  readonly format: string;
  readonly ok: boolean;
  readonly data: T;
  readonly meta?: { readonly durationMs: number };
  readonly error?: { readonly code: string; readonly message: string };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

let csrf: string | undefined;

async function send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Envelope<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method === "POST") {
    csrf ??= (await send<{ csrf: string }>("GET", "/api/session")).data.csrf;
    headers["Content-Type"] = "application/json";
    headers["X-Duo-CSRF"] = csrf;
  }
  const res = await fetch(path, { method, headers, credentials: "same-origin", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let envelope: Envelope<T> | undefined;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    envelope = undefined;
  }
  if (!res.ok || envelope === undefined || !envelope.ok) {
    throw new ApiError(res.status, envelope?.error?.code ?? "UI_TRANSPORT", envelope?.error?.message ?? `HTTP ${res.status}`);
  }
  return envelope;
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body: unknown) => send<T>("POST", path, body),
};

export const q = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();
