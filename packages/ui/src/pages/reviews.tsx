/** Human-recorded Review history (.duo-project/reviews/): pointers only, the semantic supplement apart. */
import { Empty, ErrorBox, Label, Loading, Page, Provenance, Section, useApi, Verdict } from "../components.js";
import { Link } from "../router.js";

interface Rec {
  readonly id: string; readonly path: string; readonly recorded?: { readonly by?: string; readonly at?: string };
  readonly body: {
    readonly review?: { readonly verdict?: string }; readonly diff?: { readonly identity?: string; readonly from?: string; readonly to?: string; readonly files?: readonly unknown[] };
    readonly claims?: readonly { readonly id: string; readonly rule: string; readonly subject: { readonly id: string }; readonly alignment: string; readonly reason: string; readonly evidenceIds: readonly string[]; readonly blockEligible: boolean; readonly provenance?: string }[];
    readonly evidence?: readonly { readonly id: string; readonly basis: string; readonly pointer?: { readonly path?: string; readonly lines?: readonly [number, number]; readonly commit?: string } }[];
    readonly gaps?: { readonly requiresHumanInput?: boolean; readonly gaps?: readonly { readonly id: string; readonly kind: string; readonly action: string }[] } | null;
    readonly limitations?: readonly string[];
  };
  readonly assist?: { readonly id: string; readonly path: string; readonly body: { readonly status?: string; readonly provider?: { readonly id?: string; readonly model?: string }; readonly claims?: readonly { readonly claimId: string; readonly alignment: string }[]; readonly verdict?: string } };
}

export function ReviewsPage() {
  const [load, reload] = useApi<{ readonly records: readonly Rec[]; readonly problems: readonly { readonly code: string; readonly message: string }[] }>("/api/reviews");
  return (
    <Page title="Review history" onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <p className="muted">Reviews a human recorded with <code>duoctl review --record</code>. Running a review in the UI does not record it.</p>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : (
        <>
          {load.data.problems?.length ? <div role="alert" className="box box-error">{load.data.problems.map((p) => <p key={p.message}>{p.code}: {p.message}</p>)}</div> : null}
          {load.data.records === undefined || load.data.records.length === 0 ? <Empty>No recorded reviews yet.</Empty> : (
            <table>
              <thead><tr><th scope="col">Review</th><th scope="col">Verdict</th><th scope="col">Diff</th><th scope="col">Claims</th><th scope="col">Recorded</th></tr></thead>
              <tbody>{load.data.records.map((r) => (
                <tr key={r.id}><td><Link to={`/reviews/${r.id}`}>{r.id}</Link>{r.assist === undefined ? null : <> <Label text="+ semantic supplement" tone="muted" /></>}</td><td><Verdict verdict={r.body.review?.verdict} /></td>
                  <td><code>{(r.body.diff?.identity ?? "").slice(0, 19)}</code> {r.body.diff?.from} → {r.body.diff?.to}</td><td>{r.body.claims?.length ?? 0}</td><td>{r.recorded?.at ?? ""} {r.recorded?.by ?? ""}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
    </Page>
  );
}

export function ReviewRecordPage(props: { readonly id: string }) {
  const [load, reload] = useApi<{ readonly status: string; readonly record?: Rec }>(`/api/reviews/${props.id}`);
  return (
    <Page title={`Review ${props.id}`} onRefresh={reload}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : load.data.record === undefined ? <Empty>No recorded review {props.id}.</Empty> : <RecordBody r={load.data.record} />}
    </Page>
  );
}

function RecordBody(props: { readonly r: Rec }) {
  const { r } = props;
  const ev = new Map((r.body.evidence ?? []).map((e) => [e.id, e] as const));
  return (
    <>
      <h2 className="verdict-line">Recorded verdict: <Verdict verdict={r.body.review?.verdict} /></h2>
      <p className="muted small">{r.path} · diff <code>{r.body.diff?.identity}</code> {r.body.diff?.from} → {r.body.diff?.to} · recorded {r.recorded?.at ?? ""} by {r.recorded?.by ?? ""}</p>
      <Section title="Claims" count={r.body.claims?.length ?? 0}>
        <table>
          <thead><tr><th scope="col">Alignment</th><th scope="col">Rule</th><th scope="col">Subject</th><th scope="col">Reason</th><th scope="col">Provenance</th><th scope="col">Evidence pointers</th></tr></thead>
          <tbody>{(r.body.claims ?? []).map((c) => (
            <tr key={c.id}><td><Label text={c.alignment} tone={c.alignment === "ALIGNED" ? "ok" : "info"} />{c.blockEligible ? <Label text="blocking" tone="block" /> : null}</td><td>{c.rule}</td><td><code>{c.subject.id}</code></td><td>{c.reason}</td><td><Provenance value={c.provenance} /></td>
              <td><ul className="evidence">{c.evidenceIds.map((id) => { const e = ev.get(id); return <li key={id}>{e?.basis ?? "?"} {e?.pointer?.path ?? ""}{e?.pointer?.lines === undefined ? "" : `:${e.pointer.lines[0]}-${e.pointer.lines[1]}`}{e?.pointer?.commit === undefined ? "" : ` @${e.pointer.commit.slice(0, 12)}`}</li>; })}</ul></td></tr>
          ))}</tbody>
        </table>
      </Section>
      <Section title="Gap summary" count={r.body.gaps?.gaps?.length ?? 0}>
        {r.body.gaps === null || r.body.gaps === undefined ? <Empty>None recorded.</Empty> : <ul>{(r.body.gaps.gaps ?? []).map((g) => <li key={g.id}><Label text={g.action.toUpperCase()} tone="info" /> {g.kind}</li>)}</ul>}
      </Section>
      {r.assist === undefined ? null : (
        <Section title="Semantic supplement (separate record, not deterministic history)" open={false}>
          <p className="muted small">{r.assist.path} · {r.assist.body.provider?.id ?? ""} {r.assist.body.provider?.model ?? ""}</p>
          <ul>{(r.assist.body.claims ?? []).map((c) => <li key={c.claimId}><Label text={c.alignment} tone="info" /> <code>{c.claimId}</code></li>)}</ul>
          {r.assist.body.verdict === undefined ? null : <p>With semantic assistance: <Verdict verdict={r.assist.body.verdict} /></p>}
        </Section>
      )}
      {(r.body.claims ?? []).some((c) => c.provenance !== undefined) ? <p className="muted small">Provenance legend: <Provenance value="introduced" /> <Provenance value="pre-existing" /> <Provenance value="pre-existing-touched" /> <Provenance value="unverified-at-adoption" /></p> : null}
    </>
  );
}
