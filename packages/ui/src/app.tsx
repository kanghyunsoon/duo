/** DUO Project Direction Console: navigation and routes. */
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
import { Link, usePath } from "./router.js";

export const NAV: readonly (readonly [string, string])[] = [
  ["/overview", "Overview"], ["/direction", "Direction"], ["/decisions", "Pending decisions"], ["/graph", "Graph"], ["/coverage", "Analysis coverage"],
  ["/context", "Context"], ["/review", "Review"], ["/reviews", "Review history"], ["/search", "Search"],
];

export function route(pathname: string) {
  const entity = /^\/entity\/(.+)$/u.exec(pathname);
  if (entity !== null) return <EntityPage id={decodeURIComponent(entity[1] as string)} />;
  const record = /^\/reviews\/([\w.-]+)$/u.exec(pathname);
  if (record !== null) return <ReviewRecordPage id={record[1] as string} />;
  switch (pathname) {
    case "/direction": return <DirectionPage />;
    case "/decisions": return <DecisionsPage />;
    case "/graph": return <GraphPage />;
    case "/coverage": return <CoveragePage />;
    case "/context": return <ContextPage />;
    case "/review": return <ReviewPage />;
    case "/reviews": return <ReviewsPage />;
    case "/search": return <SearchPage />;
    default: return <OverviewPage />;
  }
}

export function App() {
  const path = usePath();
  const pathname = path.split("?")[0] ?? "/";
  return (
    <div className="layout">
      <a href="#main" className="skip">Skip to content</a>
      <nav aria-label="DUO">
        <p className="brand">DUO <span className="muted small">Project Direction Console</span></p>
        <ul>{NAV.map(([to, label]) => <li key={to}><Link to={to} current={pathname === to || (to === "/overview" && pathname === "/")}>{label}</Link></li>)}</ul>
        <p className="muted small">Local only. Reads Project Truth; writes only human Decision confirm/reject.</p>
      </nav>
      <main id="main" tabIndex={-1}>{route(pathname)}</main>
    </div>
  );
}
