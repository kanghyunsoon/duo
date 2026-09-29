import { Empty, ErrorBox, Label, Loading, Loc, Page, Section, useApi } from "../components.js";
import { entityPath, Link } from "../router.js";
import type { DecisionItem, Direction } from "../types.js";

const TONE = { CONFIRMED: "ok", PROPOSED: "info", SUPERSEDED: "muted", REJECTED: "muted" } as const;
export function DecisionLabel(props: { readonly label: DecisionItem["label"] }) {
  return <Label text={props.label} tone={TONE[props.label]} />;
}

function Decisions(props: { readonly items: readonly DecisionItem[] }) {
  if (props.items.length === 0) return <Empty>None.</Empty>;
  return (
    <table>
      <thead><tr><th scope="col">ID</th><th scope="col">State</th><th scope="col">Decision</th><th scope="col">Enforcement</th><th scope="col">Source</th></tr></thead>
      <tbody>{props.items.map((d) => (
        <tr key={d.id}>
          <td><Link to={entityPath(d.id)}>{d.id}</Link></td><td><DecisionLabel label={d.label} />{d.supersededBy === null ? null : <span className="muted"> by {d.supersededBy}</span>}</td>
          <td><strong>{d.title}</strong><br /><span className="muted">{d.question}</span> = {d.answer}</td><td>{d.enforcement ?? "—"}</td><td><Loc location={d.location} /></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function DirectionPage() {
  const [load, reload] = useApi<Direction>("/api/direction");
  return (
    <Page title="Direction" onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : <DirectionBody d={load.data} />}
    </Page>
  );
}

function DirectionBody(props: { readonly d: Direction }) {
  const { d } = props;
  if (d.requirements === undefined) return <Empty>Not a DUO project yet: run duoctl init.</Empty>;
  const by = (label: DecisionItem["label"]) => d.decisions.filter((x) => x.label === label);
  const pending = d.proposals.filter((p) => p.status === "pending").length;
  return (
    <>
      <Section title="Vision">
        {d.vision === null ? <Empty>No vision document yet.</Empty> : (
          <><p><Label text={d.vision.status.toUpperCase()} tone={d.vision.status === "confirmed" ? "ok" : "info"} /> <Loc location={d.vision.location} /></p><pre className="truth">{d.vision.body.trim()}</pre></>
        )}
      </Section>
      <Section title="Milestones" count={d.milestones.length}>
        {d.milestones.length === 0 ? <Empty>No milestones yet.</Empty> : (
          <ul>{d.milestones.map((m) => <li key={m.id}><Link to={entityPath(m.id)}>{m.id}</Link> {m.title} <Label text={m.state} tone="muted" />{m.current ? <Label text="current" tone="ok" /> : null} <Loc location={m.location} /></li>)}</ul>
        )}
      </Section>
      <Section title="Requirements" count={d.requirements.length}>
        {d.requirements.length === 0 ? <Empty>No confirmed requirements yet. DUO can still analyze repository structure and changes.</Empty> : (
          <table>
            <thead><tr><th scope="col">ID</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Milestone</th><th scope="col">Priority</th><th scope="col">Source</th></tr></thead>
            <tbody>{d.requirements.map((r) => (
              <tr key={r.id}><td><Link to={entityPath(r.id)}>{r.id}</Link></td><td>{r.title}</td><td>{r.status}</td><td>{r.milestone ?? "—"}</td><td>{r.priority ?? "—"}</td><td><Loc location={r.location} /></td></tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      <Section title="Constraints" count={d.constraints.length}>
        {d.constraints.length === 0 ? <Empty>No constraints yet.</Empty> : (
          <ul>{d.constraints.map((c) => <li key={c.id}><Link to={entityPath(c.id)}>{c.id}</Link> <Label text={c.state.toUpperCase()} tone={c.state === "confirmed" ? "ok" : "muted"} /> {c.statement} <span className="muted">({c.enforcement})</span> <Loc location={c.location} /></li>)}</ul>
        )}
      </Section>
      <Section title="Active decisions" count={by("CONFIRMED").length}><Decisions items={by("CONFIRMED")} /></Section>
      <Section title="Proposed decisions (not confirmed intent)" count={by("PROPOSED").length + pending} open={by("PROPOSED").length + pending > 0}>
        <Decisions items={by("PROPOSED")} />
        {pending === 0 ? null : <p>{pending} proposal(s) wait for a human: <Link to="/decisions">Pending decisions</Link>. A proposal is not a Decision until a human confirms it.</p>}
      </Section>
      <Section title="Superseded decisions" count={by("SUPERSEDED").length} open={false}><Decisions items={by("SUPERSEDED")} /></Section>
      <Section title="Rejected decisions" count={by("REJECTED").length} open={false}><Decisions items={by("REJECTED")} /></Section>
    </>
  );
}
