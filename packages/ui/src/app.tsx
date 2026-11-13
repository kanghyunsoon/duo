/** DUO Project Direction Console: navigation and routes. */
import { Component, type ReactNode } from "react";
import { changeLanguage, message, t, type Language } from "./i18n.js";
import { Trans, useTranslation } from "react-i18next";
import { CoveragePage } from "./pages/coverage.js";
import { ContextPage } from "./pages/context.js";
import { DecisionsPage } from "./pages/decisions.js";
import { DirectionPage } from "./pages/direction.js";
import { EntityPage } from "./pages/entity.js";
import { GraphPage } from "./pages/graph.js";
import { OverviewPage } from "./pages/overview.js";
import { ReviewPage } from "./pages/review.js";
import { ReviewRecordPage, ReviewsPage } from "./pages/reviews.js";
import { SearchPage } from "./pages/search.js";
import { WorkPage } from "./pages/work.js";
import { Link, usePath } from "./router.js";

export const NAV: readonly (readonly [string, string])[] = [
  ["/overview", "Overview"], ["/direction", "Direction"], ["/decisions", "Pending decisions"], ["/work", "Work map"], ["/graph", "Graph"], ["/coverage", "Analysis coverage"],
  ["/context", "Context"], ["/review", "Review"], ["/reviews", "Review history"], ["/search", "Search"],
];

export function route(pathname: string) {
  const entity = /^\/entity\/(.+)$/u.exec(pathname);
  if (entity !== null) {
    try { return <EntityPage id={decodeURIComponent(entity[1] as string)} />; }
    catch (error) {
      if (!(error instanceof URIError)) throw error;
      return <section><h1>{t("text.Invalid address")}</h1><p>{t("text.This address is not valid. Check the link or return to Overview.")}</p><Link to="/overview">{t("text.Go to Overview")}</Link></section>;
    }
  }
  const record = /^\/reviews\/([\w.-]+)$/u.exec(pathname);
  if (record !== null) return <ReviewRecordPage id={record[1] as string} />;
  switch (pathname) {
    case "/direction": return <DirectionPage />;
    case "/decisions": return <DecisionsPage />;
    case "/graph": return <GraphPage />;
    case "/work": return <WorkPage />;
    case "/coverage": return <CoveragePage />;
    case "/context": return <ContextPage />;
    case "/review": return <ReviewPage />;
    case "/reviews": return <ReviewsPage />;
    case "/search": return <SearchPage />;
    default: return <OverviewPage />;
  }
}

class PageErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (this.state.failed) return <section role="alert"><h1>{t("text.Page unavailable")}</h1><p>{t("text.Something went wrong displaying this page. Try again or go to Overview.")}</p><button type="button" onClick={() => this.setState({ failed: false })}>{t("text.Try again")}</button> <Link to="/overview">{t("text.Go to Overview")}</Link></section>;
    return this.props.children;
  }
}

function RouteContent(props: { readonly pathname: string }) { return route(props.pathname); }

export function App() {
  const { i18n } = useTranslation();
  const path = usePath();
  const pathname = path.split("?")[0] ?? "/";
  return (
    <div className="layout">
      <a href="#main" className="skip">{t("app.skip_to_content")}</a>
      <nav aria-label={t("app.duo")}>
        <p className="brand"><Trans i18nKey="app.duo_project_direction_console" components={{ c0: <span className="muted small" /> }} /></p>
        <label className="language-picker">{t("app.language")}
          <select aria-label={t("app.language")} value={i18n.resolvedLanguage ?? "ko"} onChange={(e) => { void changeLanguage(e.target.value as Language); }}>
            <option value="ko" lang="ko">한국어</option>
            <option value="en" lang="en">English</option>
          </select>
        </label>
        <ul>{NAV.map(([to, label]) => <li key={to}><Link to={to} current={pathname === to || (to === "/overview" && pathname === "/")}>{message(label)}</Link></li>)}</ul>
        <p className="muted small">{t("app.local_only_project_truth_changes_require_human")}</p>
      </nav>
      <main id="main" tabIndex={-1}><PageErrorBoundary key={path}><RouteContent pathname={pathname} /></PageErrorBoundary></main>
    </div>
  );
}
