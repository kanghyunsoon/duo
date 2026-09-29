/** Deterministic search over Project Truth and the graph (the shared search operation). */
import { useState } from "react";
import { q } from "../api.js";
import { Empty, ErrorBox, Label, Loading, Page, useApi } from "../components.js";
import { entityPath, Link, navigate, usePath } from "../router.js";

interface Candidate { readonly source: string; readonly kind: string; readonly id: string; readonly match: string; readonly path?: string }

export function SearchPage() {
  const path = usePath();
  const term = new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "";
  const [draft, setDraft] = useState(term);
  const [load] = useApi<{ readonly candidates?: readonly Candidate[]; readonly truncated?: boolean }>(term === "" ? undefined : `/api/search?${q({ q: term })}`);
  return (
    <Page title="Search">
      <form className="form" role="search" onSubmit={(e) => { e.preventDefault(); if (draft.trim() !== "") navigate(`/search?${q({ q: draft.trim() })}`); }}>
        <label>Find <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Requirement or Decision ID, symbol, file, text" size={40} /></label>
        <button type="submit">Search</button>
      </form>
      {term === "" ? null : load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : (load.data.candidates ?? []).length === 0 ? <Empty>No match.</Empty> : (
        <ul>{load.data.candidates?.map((c) => <li key={`${c.source}${c.id}`}><Label text={c.kind} tone="muted" /> <Link to={entityPath(c.id)}>{c.id}</Link> <span className="muted">{c.match}{c.path === undefined ? "" : ` · ${c.path}`}</span></li>)}</ul>
      )}
      <p className="muted small">Review records are listed under <Link to="/reviews">Review history</Link>.</p>
    </Page>
  );
}
