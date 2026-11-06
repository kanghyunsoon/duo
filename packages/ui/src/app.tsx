/** DUO Project Direction Console: navigation and routes. */
import { Component, type ReactNode } from "react";
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
      return <section><h1>Invalid address</h1><p>This address is not valid. Check the link or return to Overview.</p><Link to="/overview">Go to Overview</Link></section>;
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
    if (this.state.failed) return <section role="alert"><h1>Page unavailable</h1><p>Something went wrong displaying this page. Try again or go to Overview.</p><button type="button" onClick={() => this.setState({ failed: false })}>Try again</button> <Link to="/overview">Go to Overview</Link></section>;
    return this.props.children;
  }
}

function RouteContent(props: { readonly pathname: string }) { return route(props.pathname); }

export function App() {
  const path = usePath();
  const pathname = path.split("?")[0] ?? "/";
  return (
    <div className="layout">
      <a href="#main" className="skip">Skip to content</a>
      <nav aria-label="DUO">
        <p className="brand">DUO <span className="muted small">Project Direction Console</span></p>
        <ul>{NAV.map(([to, label]) => <li key={to}><Link to={to} current={pathname === to || (to === "/overview" && pathname === "/")}>{label}</Link></li>)}</ul>
        <p className="muted small">Local only. Project Truth changes require human Decision actions; work activity is local runtime data.</p>
      </nav>
      <main id="main" tabIndex={-1}><PageErrorBoundary key={path}><RouteContent pathname={pathname} /></PageErrorBoundary></main>
    </div>
  );
}
