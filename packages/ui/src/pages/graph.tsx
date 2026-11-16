/**
 * Graph explorer (T18.1): a bounded relationship explorer over the existing trace and impact
 * primitives (seed, depth 1-3, server limits). Never the whole graph; no graph library (C203).
 */
import { t } from "../i18n.js";
import { Trans } from "react-i18next";
import { useState } from "react";
import { q } from "../api.js";
import { Empty, ErrorBox, Label, Loading, Page, TableScroll, useApi } from "../components.js";
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
    <Page title={t("graph.graph")} onRefresh={node === "" ? undefined : reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (draft.trim() !== "") go(draft.trim()); }}>
        <label>{t("form.seed")} <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="AUTH-03, src/a.ts, Class.method, sym:…" size={40} /></label>
        <label>{t("form.view")} <select value={kind} onChange={(e) => node !== "" && go(node, e.target.value as "trace" | "impact")}><option value="trace">{t("graph.trace")}</option><option value="impact">{t("graph.impact")}</option></select></label>
        <label>{t("form.depth")} <select value={depth} onChange={(e) => node !== "" && go(node, kind, Number(e.target.value))}>{[1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <button type="submit">{t("graph.explore")}</button>
      </form>
      {node === "" ? <Empty>{t("graph.empty_hint")}</Empty>
        : load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : <GraphView g={load.data} go={(n) => { setDraft(n); go(n); }} />}
    </Page>
  );
}

function NodeLink(props: { readonly id: string; readonly go: (id: string) => void }) {
  return (
    <span className="node"><button type="button" className="link" onClick={() => props.go(props.id)} title={t("graph.explore_from_here")}>{props.id}</button> <Link to={entityPath(props.id)} className="small">{t("graph.detail")}</Link></span>
  );
}

function GraphView(props: { readonly g: GraphPayload; readonly go: (id: string) => void }) {
  const { g } = props;
  if (g.status === "not-found") return <Empty>{t("graph.no_such_node_in_the_graph")}</Empty>;
  if (g.status !== "found") return <p role="alert" className="box box-error">{g.status}</p>;
  return (
    <>
      <p>{g.index === "current" ? null : <IndexState status={g.index} />} {g.truncated ? <Label text="truncated: limits reached" tone="warn" /> : null}</p>
      {g.nodes !== undefined ? (
        <div className="graph-columns">
          {[...new Set(g.nodes.map((n) => n.depth))].sort().map((d) => (
            <section key={d} aria-label={t("graph.depth_label", { depth: d })}>
              <h2>{d === 0 ? t("context.seeds") : t("graph.depth_label", { depth: d })}</h2>
              <ul>{g.nodes?.filter((n) => n.depth === d).sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.id.localeCompare(b.id)).map((n) => (
                <li key={n.id}><Label text={n.type} tone="muted" /> <NodeLink id={n.id} go={props.go} /></li>
              ))}</ul>
            </section>
          ))}
        </div>
      ) : null}
      {g.edges === undefined ? null : (
        <details className="section"><summary><h2><Trans i18nKey="graph.edges" components={{ v0: <>{String((g.edges.length) ?? "")}</> }} /></h2></summary>
          <TableScroll label={t("graph.edges_label")}><table><thead><tr><th scope="col">{t("graph.from")}</th><th scope="col">{t("graph.edge")}</th><th scope="col">{t("graph.to")}</th></tr></thead>
            <tbody>{g.edges.map((e) => <tr key={`${e.from} ${e.type} ${e.to}`}><td><code>{e.from}</code></td><td>{e.type}</td><td><code>{e.to}</code></td></tr>)}</tbody></table>
          </TableScroll>
        </details>
      )}
      {g.items === undefined ? null : (
        <>
          {g.items.length === 0 ? <Empty>{t("graph.no_recorded_relation_reaches_another_node")}</Empty> : (
            <TableScroll label={t("graph.relations_label")}><table><thead><tr><th scope="col">{t("graph.relation")}</th><th scope="col">{t("graph.depth_2")}</th><th scope="col">{t("graph.node")}</th><th scope="col">{t("graph.via")}</th></tr></thead>
              <tbody>{g.items.map((i) => <tr key={i.id}><td>{i.relation}</td><td>{i.depth}</td><td><NodeLink id={i.id} go={props.go} /></td><td><Trans i18nKey="graph.from_2" components={{ v0: <>{i.via.edge}</>, c1: <code />, v2: <>{i.via.from}</> }} /></td></tr>)}</tbody></table></TableScroll>
          )}
          {g.notice === undefined ? null : <p className="muted small">{g.notice}</p>}
          {(g.limitations ?? []).length === 0 ? null : <ul className="muted small">{g.limitations?.map((l) => <li key={l.code}>{l.message}</li>)}</ul>}
        </>
      )}
    </>
  );
}
