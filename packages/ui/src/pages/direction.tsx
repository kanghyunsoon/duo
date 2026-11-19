import { t } from "../i18n.js";
import { Trans } from "react-i18next";
import { Empty, ErrorBox, Label, Loading, Loc, Page, TableScroll, Section, useApi } from "../components.js";
import { entityPath, Link } from "../router.js";
import type { DecisionItem, Direction } from "../types.js";

const TONE = { CONFIRMED: "ok", PROPOSED: "info", SUPERSEDED: "muted", REJECTED: "muted" } as const;
export function DecisionLabel(props: { readonly label: DecisionItem["label"] }) {
  return <Label text={props.label} tone={TONE[props.label]} />;
}

function Decisions(props: { readonly items: readonly DecisionItem[] }) {
  if (props.items.length === 0) return <Empty>{t("direction.none")}</Empty>;
  return <div className="decision-list">{props.items.map((d) => (
    <article className="decision-row" key={d.id}>
      <div className="decision-row-head"><Link to={entityPath(d.id)}>{d.title}</Link><DecisionLabel label={d.label} /></div>
      <details className="row-details"><summary>{d.id} · {t("design.details")}</summary>
        <p>{d.question} = {d.answer}</p>
        <p>{t("direction.enforcement")}: {d.enforcement ?? "—"}</p>
        {d.supersededBy === null ? null : <p>{d.supersededBy}</p>}
        <Loc location={d.location} />
      </details>
    </article>
  ))}</div>;

}

export function DirectionPage() {
  const [load, reload] = useApi<Direction>("/api/direction");
  return (
    <Page title={t("direction.direction")} onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : <DirectionBody d={load.data} />}
    </Page>
  );
}

function DirectionBody(props: { readonly d: Direction }) {
  const { d } = props;
  if (d.requirements === undefined) return <Empty>{t("direction.not_a_duo_project_yet_run_duoctl")}</Empty>;
  const by = (label: DecisionItem["label"]) => d.decisions.filter((x) => x.label === label);
  const pending = d.proposals.filter((p) => p.status === "pending").length;
  return (
    <div className="direction-dashboard">
      <p className="page-caption">{t("design.direction_caption")}</p>
      <div className="metric-grid">
        <a href="#direction-requirements"><span>{t("design.requirements")}</span><strong>{d.requirements.length}</strong></a>
        <a href="#direction-decisions"><span>{t("design.decisions")}</span><strong>{by("CONFIRMED").length}</strong></a>
        <Link to="/decisions"><span>{t("design.pending")}</span><strong>{pending}</strong></Link>
        <a href="#direction-constraints"><span>{t("design.constraints")}</span><strong>{d.constraints.length}</strong></a>
      </div>
      <Section title={t("direction.vision")} open={false}>
        {d.vision === null ? <Empty>{t("direction.no_vision_document_yet")}</Empty> : (
          <><p><Label text={d.vision.status.toUpperCase()} tone={d.vision.status === "confirmed" ? "ok" : "info"} /> <Loc location={d.vision.location} /></p><pre className="truth">{d.vision.body.trim()}</pre></>
        )}
      </Section>
      <Section title={t("direction.milestones")} count={d.milestones.length} open={d.milestones.length > 0}>
        {d.milestones.length === 0 ? <Empty>{t("direction.no_milestones_yet")}</Empty> : (
          <ul>{d.milestones.map((m) => <li key={m.id}><Link to={entityPath(m.id)}>{m.id}</Link> {m.title} <Label text={m.state} tone="muted" />{m.current ? <Label text="current" tone="ok" /> : null} <Loc location={m.location} /></li>)}</ul>
        )}
      </Section>
      <div id="direction-requirements" /><Section title={t("direction.requirements")} count={d.requirements.length} open={false}>
        {d.requirements.length === 0 ? <Empty>{t("direction.no_confirmed_requirements_yet_duo_can_still")}</Empty> : (
          <TableScroll label="Requirements"><table>
            <thead><tr><th scope="col">{t("direction.id")}</th><th scope="col">{t("direction.title")}</th><th scope="col">{t("direction.status")}</th><th scope="col">{t("direction.milestone")}</th><th scope="col">{t("direction.priority")}</th><th scope="col">{t("direction.source")}</th></tr></thead>
            <tbody>{d.requirements.map((r) => (
              <tr key={r.id}><td><Link to={entityPath(r.id)}>{r.id}</Link></td><td>{r.title}</td><td>{r.status}</td><td>{r.milestone ?? "—"}</td><td>{r.priority ?? "—"}</td><td><Loc location={r.location} /></td></tr>
            ))}</tbody>
          </table></TableScroll>
        )}
      </Section>
      <div id="direction-constraints" /><Section title={t("direction.constraints")} count={d.constraints.length} open={false}>
        {d.constraints.length === 0 ? <Empty>{t("direction.no_constraints_yet")}</Empty> : (
          <ul>{d.constraints.map((c) => <li key={c.id}><Link to={entityPath(c.id)}>{c.id}</Link> <Label text={c.state.toUpperCase()} tone={c.state === "confirmed" ? "ok" : "muted"} /> {c.statement} <span className="muted">({c.enforcement})</span> <Loc location={c.location} /></li>)}</ul>
        )}
      </Section>
      <div id="direction-decisions" /><Section title={t("direction.active_decisions")} count={by("CONFIRMED").length}><Decisions items={by("CONFIRMED")} /></Section>
      <Section title={t("direction.proposed_decisions_not_confirmed_intent")} count={by("PROPOSED").length + pending} open={by("PROPOSED").length + pending > 0}>
        <Decisions items={by("PROPOSED")} />
        {pending === 0 ? null : <p><Trans i18nKey="direction.proposal_s_wait_for_a_human_pending" components={{ v0: <>{String((pending) ?? "")}</>, c1: <Link to="/decisions" children={null} /> }} /></p>}
      </Section>
      <Section title={t("direction.superseded_decisions")} count={by("SUPERSEDED").length} open={false}><Decisions items={by("SUPERSEDED")} /></Section>
      <Section title={t("direction.rejected_decisions")} count={by("REJECTED").length} open={false}><Decisions items={by("REJECTED")} /></Section>
    </div>
  );
}
