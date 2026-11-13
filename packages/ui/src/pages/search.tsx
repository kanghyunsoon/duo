/** Deterministic search over Project Truth and the graph (the shared search operation). */
import { t } from "../i18n.js";
import { Trans } from "react-i18next";
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
    <Page title={t("search.search")}>
      <form className="form" role="search" onSubmit={(e) => { e.preventDefault(); if (draft.trim() !== "") navigate(`/search?${q({ q: draft.trim() })}`); }}>
        <label>{t("form.find")} <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("text.Requirement or Decision ID, symbol, file, text")} size={40} /></label>
        <button type="submit">{t("search.search")}</button>
      </form>
      {term === "" ? null : load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : (load.data.candidates ?? []).length === 0 ? <Empty>{t("search.no_match")}</Empty> : (
        <ul>{load.data.candidates?.map((c) => <li key={`${c.source}${c.id}`}><Label text={c.kind} tone="muted" /> <Link to={entityPath(c.id)}>{c.id}</Link> <span className="muted">{c.match}{c.path === undefined ? "" : ` · ${c.path}`}</span></li>)}</ul>
      )}
      <p className="muted small"><Trans i18nKey="search.review_records_are_listed_under_review_history" components={{ c0: <Link to="/reviews" children={null} /> }} /></p>
    </Page>
  );
}
