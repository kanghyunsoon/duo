/** Shared presentational pieces. Status is always text (never color alone); no scores anywhere. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { PROVENANCE_BADGES } from "./provenance.js";
import type { Location } from "./types.js";

export type Load<T> = { readonly state: "loading" } | { readonly state: "ok"; readonly data: T; readonly durationMs?: number } | { readonly state: "error"; readonly error: ApiError | Error };

/** GET once on mount and on reload(): no polling, no watcher (C145, T18.1). */
export function useApi<T>(path: string | undefined): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === undefined) return;
    let live = true;
    setLoad({ state: "loading" });
    api.get<T>(path).then(
      (e) => { if (live) setLoad({ state: "ok", data: e.data, ...(e.meta === undefined ? {} : { durationMs: e.meta.durationMs }) }); },
      (error: unknown) => { if (live) setLoad({ state: "error", error: error instanceof Error ? error : new Error(String(error)) }); },
    );
    return () => { live = false; };
  }, [path, tick]);
  return [load, useCallback(() => setTick((t) => t + 1), [])];
}

export function Loading() {
  return <p role="status" className="muted">Loading…</p>;
}

export function ErrorBox(props: { readonly error: Error }) {
  const e = props.error;
  const session = e instanceof ApiError && e.status === 401;
  return (
    <div role="alert" className="box box-error">
      <strong>{session ? "No UI session" : "Request failed"}</strong>
      <p>{session ? "Open the URL printed by duoctl ui (the session is valid for one server run)." : e.message}</p>
      {e instanceof ApiError ? <p className="muted">{e.code} · HTTP {e.status}</p> : null}
    </div>
  );
}

export function Page(props: { readonly title: string; readonly children: ReactNode; readonly onRefresh?: (() => void) | undefined; readonly durationMs?: number | undefined }) {
  return (
    <section aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title">{props.title}</h1>
        {props.onRefresh === undefined ? null : <button type="button" onClick={props.onRefresh}>Refresh</button>}
        {props.durationMs === undefined ? null : <span className="muted small" aria-label="server time">{props.durationMs} ms</span>}
      </header>
      {props.children}
    </section>
  );
}

export function Section(props: { readonly title: string; readonly children: ReactNode; readonly count?: number; readonly open?: boolean }) {
  return (
    <details className="section" open={props.open ?? true}>
      <summary><h2>{props.title}{props.count === undefined ? null : <span className="count"> ({props.count})</span>}</h2></summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}

export function Empty(props: { readonly children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

const VERDICT: Readonly<Record<string, string>> = { PASS: "✓", WARN: "!", ASK: "?", BLOCK: "✕" };
export function Verdict(props: { readonly verdict: string | undefined | null }) {
  const v = props.verdict ?? "—";
  return <span className={`badge verdict verdict-${v.toLowerCase()}`}><span aria-hidden="true">{VERDICT[v] ?? ""} </span>{v}</span>;
}

/** CONFIRMED, PROPOSED, SUPERSEDED, REJECTED, pending, … as text badges. */
export function Label(props: { readonly text: string; readonly tone?: "ok" | "info" | "warn" | "muted" | "block" }) {
  return <span className={`badge tone-${props.tone ?? "info"}`}>{props.text}</span>;
}

export function Provenance(props: { readonly value: string | undefined }) {
  if (props.value === undefined) return null;
  const p = PROVENANCE_BADGES[props.value] ?? { text: props.value, tone: "info" as const, help: "" };
  return <span className={`badge tone-${p.tone}`} title={p.help}>{p.text}</span>;
}

export function Level(props: { readonly level: string }) {
  const text = props.level === "L0" ? "L0 · file-level analysis" : props.level === "L1" ? "L1 · structural" : props.level === "L2" ? "L2 · partial semantics" : props.level;
  return <span className={`badge level level-${props.level.toLowerCase()}`}>{text}</span>;
}

export function Loc(props: { readonly location: Location | undefined }) {
  const l = props.location;
  if (l === undefined) return null;
  const lines = l.startLine === undefined ? "" : l.endLine === undefined || l.endLine === l.startLine ? `:${l.startLine}` : `:${l.startLine}-${l.endLine}`;
  return <code className="loc">{l.path}{lines}</code>;
}

export function Command(props: { readonly children: string }) {
  return <code className="command">{props.children}</code>;
}
