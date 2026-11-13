/** DUO Project Direction Console: navigation and routes. */
import { Component, type ReactNode, useState } from "react";
import { changeLanguage, message, t, type Language } from "./i18n.js";
import { useTranslation } from "react-i18next";
import { DecisionsPage } from "./pages/decisions.js";
import { DirectionPage } from "./pages/direction.js";
import { EntityPage } from "./pages/entity.js";
import { OverviewPage } from "./pages/overview.js";
import { ReviewPage } from "./pages/review.js";
import { ReviewRecordPage, ReviewsPage } from "./pages/reviews.js";
import { SearchPage } from "./pages/search.js";
import { WorkPage } from "./pages/work.js";
import { Link, usePath } from "./router.js";

export const NAV: readonly (readonly [string, string])[] = [
  ["/overview", "Overview"], ["/direction", "Direction"], ["/decisions", "Pending decisions"], ["/work", "Work map"],
   ["/review", "Review"], ["/reviews", "Review history"], ["/search", "Search"],
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
    case "/graph": return <WorkPage />; // Compatibility for old bookmarks.
    case "/work": return <WorkPage />;
    case "/coverage": return <OverviewPage />;
    case "/context": return <WorkPage />;
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
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem("duo.ui.sidebar.collapsed") === "true"; }
    catch { return false; }
  });
  const toggleSidebar = () => {
    setCollapsed(previous => {
      const next = !previous;
      try { window.localStorage.setItem("duo.ui.sidebar.collapsed", String(next)); } catch { /* Optional preference storage. */ }
      return next;
    });
  };
  const path = usePath();
  const pathname = path.split("?")[0] ?? "/";
  return (
    <div className={`layout${collapsed ? " sidebar-collapsed" : ""}`}>
      <a href="#main" className="skip">{t("app.skip_to_content")}</a>
      <nav aria-label={t("app.duo")}>
        <button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-expanded={!collapsed} aria-controls="sidebar-links" aria-label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")} title={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d={collapsed ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"}/></svg>
        </button>
        <p className="brand">DUO</p>
        <label className="language-picker">{t("app.language")}
          <select aria-label={t("app.language")} value={i18n.resolvedLanguage ?? "ko"} onChange={(e) => { void changeLanguage(e.target.value as Language); }}>
            <option value="ko" lang="ko">한국어</option>
            <option value="en" lang="en">English</option>
          </select>
        </label>
        <ul id="sidebar-links">{NAV.map(([to, label]) => <li key={to} title={message(label)}><Link to={to} current={pathname === to || (to === "/overview" && pathname === "/")}><span className="nav-icon" aria-hidden="true">{["◫", "◎", "◷", "⌘", "✓", "↺", "⌕"][NAV.findIndex(([url]) => url === to)]}</span><span className="nav-label">{message(label)}</span></Link></li>)}</ul>
        <details className="nav-info"><summary>{t("design.local_workspace")}</summary><p>{t("app.local_only_project_truth_changes_require_human")}</p></details>
      </nav>
      <main id="main" tabIndex={-1}><PageErrorBoundary key={path}><RouteContent pathname={pathname} /></PageErrorBoundary></main>
    </div>
  );
}
