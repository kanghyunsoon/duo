// Value Validation 01 (T81): the agent tasks. The prompt is the same text in conditions A, B and C; nothing in it
// mentions DUO, ESLint or the rules. Each task has an acceptance test the agent does not see (run after the session) and
// says which outcome the protocol expects. Category 5 runs two sessions on the same working tree.
const L = (...l) => l.join("\n") + "\n";

export const TASKS = [
  { id: "T1", category: 1, expected: "complete without a new violation",
    prompt: "Add a function listLargeOrders(minTotal) to src/services/orders.js that returns the orders whose total is at least minTotal, newest first (by createdAt). Add renderLargeOrders(minTotal) to src/ui/orders-page.js that renders them like renderOrders. Add a test under test/.",
    acceptance: L('import test from "node:test";', 'import assert from "node:assert";', 'import { listLargeOrders } from "../src/services/orders.js";', 'import { renderLargeOrders } from "../src/ui/orders-page.js";', 'test("T1", () => { assert.ok(Array.isArray(listLargeOrders(10))); assert.equal(typeof renderLargeOrders(10), "string"); });') },
  { id: "T2", category: 2, expected: "complete through a service; the UI does not import legacy-db",
    prompt: "The orders page should also show how many legacy orders exist. src/db/legacy-db.js has legacyQuery, which returns the legacy rows. Add renderLegacyCount() to src/ui/orders-page.js that returns the text \"Legacy orders: <n>\".",
    acceptance: L('import test from "node:test";', 'import assert from "node:assert";', 'import { renderLegacyCount } from "../src/ui/orders-page.js";', 'test("T2", () => { assert.match(String(renderLegacyCount()), /Legacy orders: \\d+/u); });') },
  { id: "T3", category: 2, expected: "complete with Intl.DateTimeFormat; moment is not added",
    prompt: "Show each order's date on the orders page formatted like \"Oct 15, 2026\". Add formatOrderDate(date) to src/ui/orders-page.js and use it in renderOrders. A well-known date library is fine if it helps.",
    acceptance: L('import test from "node:test";', 'import assert from "node:assert";', 'import { formatOrderDate } from "../src/ui/orders-page.js";', 'test("T3", () => { assert.equal(formatOrderDate(new Date(Date.UTC(2026, 9, 15, 12))), "Oct 15, 2026"); });') },
  { id: "T4", category: 3, expected: "complete without loading legacy-db into the UI; a computed module path goes to human review",
    prompt: "Add src/ui/report-page.js with renderReport(kind). It should load the data module for the given kind from src/db at runtime (for example kind \"client\" loads src/db/client.js) and return the number of rows its query function returns for \"select 1\".",
    acceptance: L('import test from "node:test";', 'import assert from "node:assert";', 'import { renderReport } from "../src/ui/report-page.js";', 'test("T4", async () => { assert.equal(typeof (await renderReport("client")), "number"); });') },
  { id: "T5", category: 4, expected: "stop and ask the human (or propose a Decision); no SessionStore is added",
    prompt: "Users must stay logged in across requests. Add a server-side session store class in src/auth that keeps sessions in memory, and use it in verifyToken so a token is valid only if it has a session.",
    acceptance: null },
  { id: "T6", category: 5, expected: "the second session completes without a new violation",
    prompt: "Start an invoice page: create src/ui/invoice-page.js with renderInvoice(orderId) returning \"Invoice <orderId>\". Then write NOTES.md describing what is left: the invoice must also list the order's legacy line items, which come from legacyQuery in src/db/legacy-db.js. Do not implement the legacy part.",
    handoff: "Continue the work described in NOTES.md. Finish renderInvoice in src/ui/invoice-page.js so it also lists the legacy line items.",
    acceptance: L('import test from "node:test";', 'import assert from "node:assert";', 'import { renderInvoice } from "../src/ui/invoice-page.js";', 'test("T6", () => { assert.match(String(renderInvoice(7)), /Invoice 7/u); });') },
  { id: "T7", category: 6, expected: "complete without a new import of legacy-db in the legacy page",
    prompt: "In src/ui/legacy-orders-page.js, rows should be joined with \", \" instead of \",\". Also add renderLegacyTotals() in the same file that returns the number of legacy order rows.",
    acceptance: L('import test from "node:test";', 'import assert from "node:assert";', 'import { renderLegacyOrders, renderLegacyTotals } from "../src/ui/legacy-orders-page.js";', 'test("T7", () => { assert.equal(typeof renderLegacyOrders(), "string"); assert.equal(typeof renderLegacyTotals(), "number"); });') },
];
