/** Entity detail: a Truth definition (exact source slice) or a graph node, with its direct relations. */
import { Empty, ErrorBox, Label, Loading, Loc, Page, Section, useApi } from "../components.js";
import { Link } from "../router.js";
import type { GraphPayload, Location } from "../types.js";
import { DecisionLabel } from "./direction.js";

interface EntityData {
  readonly status: string; readonly id: string; readonly type?: string; readonly text?: string; readonly trace?: GraphPayload;
  readonly definition?: { readonly id: string; readonly title?: string; readonly statement?: string; readonly status?: string; readonly state?: string; readonly label?: "CONFIRMED" | "PROPOSED" | "SUPERSEDED" | "REJECTED"; readonly location?: Location; readonly question?: string; readonly answer?: string };
}

export function EntityPage(props: { readonly id: string }) {
  const [load, reload] = useApi<EntityData>(`/api/entity/${encodeURIComponent(props.id)}`);
  return (
    <Page title={props.id} onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : load.data.status !== "found" ? <Empty>{props.id} is not a Truth definition or graph node.</Empty> : <Body e={load.data} />}
    </Page>
  );
}

function Body(props: { readonly e: EntityData }) {
  const { e } = props;
  const d = e.definition;
  return (
    <>
      <p><Label text={e.type ?? "node"} tone="muted" /> {d?.label === undefined ? null : <DecisionLabel label={d.label} />} {d?.status === undefined ? null : <Label text={d.status} tone="info" />}
        {e.type === "proposal" ? <Label text="PROPOSED · not confirmed intent" tone="info" /> : null} {d?.title ?? d?.statement ?? ""} <Loc location={d?.location} /></p>
      {d?.question === undefined ? null : <p><code>{d.question}</code> = {d.answer}</p>}
      {e.text === undefined ? null : <Section title="Definition source"><pre className="truth">{e.text}</pre></Section>}
      {e.trace?.nodes === undefined ? null : (
        <Section title="Direct relations" count={e.trace.edges?.length ?? 0}>
          {(e.trace.edges ?? []).length === 0 ? <Empty>No recorded relation.</Empty> : (
            <ul>{e.trace.edges?.map((x) => <li key={`${x.from}${x.type}${x.to}`}><code>{x.from}</code> {x.type} <code>{x.to}</code></li>)}</ul>
          )}
          <p><Link to={`/graph?node=${encodeURIComponent(e.id)}`}>Explore in the graph</Link></p>
        </Section>
      )}
    </>
  );
}
