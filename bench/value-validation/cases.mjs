// Value Validation 01 (T81): ground-truth cases for the deterministic detection test, declared before any result.
//
// truth: what the written rule (fixture.mjs RULES) says about the change, judged by a person from the rule text alone.
// scope: whether the change is inside what each checker documents that it can see, declared from the tools' documented
// contracts, not from their results:
//   eslint: no-restricted-imports checks static import/export declarations of files under src/ui/ by specifier
//     pattern (not require(), not dynamic import(), not what another module re-exports); no-restricted-syntax checks
//     declaration names; scripts/check-deps.mjs checks package.json dependency fields.
//   duo: forbids.imported_paths checks changed import, export-from, require and dynamic import statements that resolve
//     exactly to the file (not re-exports through another module, not unresolved specifiers) anywhere in the
//     repository; forbids.dependencies checks dependencies added to a package.json; forbids.symbols checks changed
//     symbols by qualified name. The adoption baseline exempts violations that existed at adoption.
// A case outside a checker's scope is reported separately and never counted as a true negative or a false negative.
// Category 5 (handing a task to a new session or another agent) has no deterministic case: it is measured only in the
// agent runs (agent.mjs).

const L = (...l) => l.join("\n") + "\n";
const replace = (find, by) => ({ find, by });

export const CASES = [
  // 1. normal work that follows the rules
  { id: "N1", category: 1, rule: "R1", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "new UI page uses src/db/client.js",
    write: { "src/ui/history-page.js": L('import { query } from "../db/client.js";', "", "export function renderHistory() {", '  return query("select * from history").rows.length;', "}") } },
  { id: "N2", category: 1, rule: "R3", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "new token helper without a session store",
    edit: { "src/auth/token.js": replace("export function verifyToken", "export function verifyRefreshToken(token) {\n  return verifyToken(token) && token.startsWith(\"r.\");\n}\n\nexport function verifyToken") } },
  { id: "N3", category: 1, rule: "R2", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "adds an allowed dependency (date-fns)",
    pkg: { dependencies: { "date-fns": "4.1.0" } } },
  { id: "N4", category: 1, rule: "none", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "changes how the orders page renders",
    edit: { "src/ui/orders-page.js": replace("<li>", "<li class=\"order\">") } },
  // 2. clear violations
  { id: "V1", category: 2, rule: "R1", truth: "violation", scope: { eslint: "in", duo: "in" }, summary: "new UI page imports legacy-db",
    write: { "src/ui/customer-page.js": L('import { legacyQuery } from "../db/legacy-db.js";', "", "export function renderCustomers() {", '  return legacyQuery("select * from customers").length;', "}") } },
  { id: "V2", category: 2, rule: "R1", truth: "violation", scope: { eslint: "in", duo: "in" }, summary: "existing UI page gains an import of legacy-db",
    edit: { "src/ui/orders-page.js": replace('import { listOrders } from "../services/orders.js";', 'import { listOrders } from "../services/orders.js";\nimport { legacyQuery } from "../db/legacy-db.js";\n\nexport const legacyCount = () => legacyQuery("select 1").length;') } },
  { id: "V3", category: 2, rule: "R2", truth: "violation", scope: { eslint: "in", duo: "in" }, summary: "adds the moment dependency",
    pkg: { dependencies: { moment: "2.30.1" } } },
  { id: "V4", category: 2, rule: "R3", truth: "violation", scope: { eslint: "in", duo: "in" }, summary: "new RedisSessionStore class",
    write: { "src/auth/redis-session-store.js": L("export class RedisSessionStore {", "  get(id) {", "    return id;", "  }", "}") } },
  // 3. where analysis reaches its limits
  { id: "L1", category: 3, rule: "R1", truth: "violation", scope: { eslint: "out", duo: "out" }, summary: "UI page imports legacyQuery through the existing src/db/index.js barrel",
    write: { "src/ui/report-page.js": L('import { legacyQuery } from "../db/index.js";', "", "export function renderReport() {", '  return legacyQuery("select * from report").length;', "}") } },
  { id: "L2", category: 3, rule: "R1", truth: "violation", scope: { eslint: "out", duo: "out" }, summary: "UI page loads legacy-db with a computed dynamic import",
    write: { "src/ui/lazy-page.js": L("export async function renderLazy(name = \"legacy-db\") {", "  const db = await import(`../db/${name}.js`);", '  return db.legacyQuery("select 1").length;', "}") } },
  { id: "L3", category: 3, rule: "R1", truth: "violation", scope: { eslint: "out", duo: "in" }, summary: "UI page requires legacy-db through createRequire",
    write: { "src/ui/require-page.js": L('import { createRequire } from "node:module";', "", "const require = createRequire(import.meta.url);", 'const { legacyQuery } = require("../db/legacy-db.js");', "", "export const renderRequire = () => legacyQuery(\"select 1\").length;") } },
  { id: "L4", category: 3, rule: "R1", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "new service (not UI) imports legacy-db, which R1 allows",
    write: { "src/services/archive.js": L('import { legacyQuery } from "../db/legacy-db.js";', "", "export function archive() {", '  return legacyQuery("select * from archive");', "}") } },
  { id: "L5", category: 3, rule: "R3", truth: "violation", scope: { eslint: "in", duo: "in" }, summary: "session store as an arrow function constant",
    write: { "src/auth/cache.js": L("export const createSessionStore = () => new Map();") } },
  // 4. the rule itself changes with a person's approval
  { id: "H1", category: 4, rule: "R2", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "a person approves moment; then the dependency is added",
    approval: true, pkg: { dependencies: { moment: "2.30.1" } } },
  // 6. adopting the checks in an existing code base (legacy debt)
  { id: "D1", category: 6, rule: "R1", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "edits a non-import line of the legacy UI page",
    edit: { "src/ui/legacy-orders-page.js": replace('.join(",")', '.join(", ")') } },
  { id: "D2", category: 6, rule: "R3", truth: "compliant", scope: { eslint: "in", duo: "in" }, summary: "edits the body of the legacy MemorySessionStore",
    edit: { "src/auth/memory-session-store.js": replace("return this.sessions.get(id);", "return this.sessions.get(String(id));") } },
  { id: "D3", category: 6, rule: "R1", truth: "violation", scope: { eslint: "in", duo: "in" }, summary: "the legacy UI page gains a second import of legacy-db",
    edit: { "src/ui/legacy-orders-page.js": replace("export function renderLegacyOrders", 'import { legacyQuery as legacyCount } from "../db/legacy-db.js";\n\nexport const countLegacy = () => legacyCount("select 1").length;\n\nexport function renderLegacyOrders') } },
];
