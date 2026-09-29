/**
 * Graph explorer (T18.1): a bounded relationship explorer over the existing trace and impact
 * primitives (seed, depth 1-3, server limits). Never the whole graph; no graph library (C203).
 */
import { useState } from "react";
import { q } from "../api.js";
import { Empty, ErrorBox, Label, Loading, Page, useApi } from "../components.js";
import { entityPath, Link, navigate, usePath } from "../router.js";
import type { GraphPayload } from "../types.js";
import { IndexState } from "./overview.js";

const TYPE_ORDER = ["project", "milestone", "requirement", "decision", "issue", "file", "symbol", "test"];

export function GraphPage() {
  const path = usePath();
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  const node = params.get("node") ?? "";
  const kind = params.get("kind") === "impact" ? "impact" : "trace";
  const depth = Math.min(3, Math.max(1, Number(params.get("depth") ?? "1") || 1));
  const [draft, setDraft] = useState(node);
  const go = (n: string, k = kind, d = depth) => navigate(`/graph?${q({ node: n, kind: k, depth: d })}`);
  const [load, reload] = useApi<GraphPayload>(node === "" ? undefined : `/api/graph?${q({ node, kind, depth })}`);
  return (
    <Page title="Graph" onRefresh={node === "" ? undefined : reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (draft.trim() !== "") go(draft.trim()); }}>
        <label>Seed <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="AUTH-03, src/a.ts, Class.method, sym:…" size={40} /></label>
        <label>View <select value={kind} onChange={(e) => node !== "" && go(node, e.target.value as "trace" | "impact")}><option value="trace">trace (relations)</option><option value="impact">impact (what may be affected)</option></select></label>
        <label>Depth <select value={depth} onChange={(e) => node !== "" && go(node, kind, Number(e.target.value))}>{[1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <button type="submit">Explore</button>
      </form>
      {node === "" ? <Empty>Choose a seed: a Requirement or Decision ID, a file path or a symbol. The explorer shows a bounded neighbourhood, never the whole graph.</Empty>
        : load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : <GraphView g={load.data} go={(n) => { setDraft(n); go(n); }} />}
    </Page>
  );
}

function NodeLink(props: { readonly id: string; readonly go: (id: string) => void }) {
  return (
    <span className="node"><button type="button" className="link" onClick={() => props.go(props.id)} title="explore from here">{props.id}</button> <Link to={entityPath(props.id)} className="small">detail</Link></span>
  );
}

function GraphView(props: { readonly g: GraphPayload; readonly go: (id: string) => void }) {
  const { g } = props;
  if (g.status === "not-found") return <Empty>No such node in the graph.</Empty>;
  if (g.status !== "found") return <p role="alert" className="box box-error">{g.status}</p>;
  return (
    <>
      <p>{g.index === "current" ? null : <IndexState status={g.index} />} {g.truncated ? <Label text="truncated: limits reached" tone="warn" /> : null}</p>
      {g.nodes !== undefined ? (
        <div className="graph-columns">
          {[...new Set(g.nodes.map((n) => n.depth))].sort().map((d) => (
            <section key={d} aria-label={`depth ${d}`}>
              <h2>{d === 0 ? "Seed" : `Depth ${d}`}</h2>
              <ul>{g.nodes?.filter((n) => n.depth === d).sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.id.localeCompare(b.id)).map((n) => (
                <li key={n.id}><Label text={n.type} tone="muted" /> <NodeLink id={n.id} go={props.go} /></li>
              ))}</ul>
            </section>
          ))}
        </div>
      ) : null}
      {g.edges === undefined ? null : (
        <details className="section"><summary><h2>Edges ({g.edges.length})</h2></summary>
          <table><thead><tr><th scope="col">From</th><th scope="col">Edge</th><th scope="col">To</th></tr></thead>
            <tbody>{g.edges.map((e) => <tr key={`${e.from} ${e.type} ${e.to}`}><td><code>{e.from}</code></td><td>{e.type}</td><td><code>{e.to}</code></td></tr>)}</tbody></table>
        </details>
      )}
      {g.items === undefined ? null : (
        <>
          {g.items.length === 0 ? <Empty>No recorded relation reaches another node.</Empty> : (
            <table><thead><tr><th scope="col">Relation</th><th scope="col">Depth</th><th scope="col">Node</th><th scope="col">Via</th></tr></thead>
              <tbody>{g.items.map((i) => <tr key={i.id}><td>{i.relation}</td><td>{i.depth}</td><td><NodeLink id={i.id} go={props.go} /></td><td>{i.via.edge} from <code>{i.via.from}</code></td></tr>)}</tbody></table>
          )}
          {g.notice === undefined ? null : <p className="muted small">{g.notice}</p>}
          {(g.limitations ?? []).length === 0 ? null : <ul className="muted small">{g.limitations?.map((l) => <li key={l.code}>{l.message}</li>)}</ul>}
        </>
      )}
    </>
  );
}
