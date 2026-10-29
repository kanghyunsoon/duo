/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { assertNoPrivatePathsInEvidence, assessTable, atomicWriteJson, atomicWriteText, compareFocusSequence, hasUnverifiedFindings, runAuditLifecycle, sanitizeAuditArtifact, serializeAuditError, storeAuditRecord, writeAuditSummary, type AuditRecord, type AuditTableSnapshot, type SerializedAuditError } from "./ui-a11y-artifacts.js";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { recordReview, reviewChanges } from "@duo-director/director";
import { indexRepository, openProjectGraphStore } from "@duo-director/graph";
import { LLMProviderPool, startDuoUiServer, type DuoUiServer } from "@duo-director/integration";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = path.join(ROOT, "fixtures");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 320, height: 800 }] as const;
const SCHEMES = ["light", "dark"] as const;
const PAGES = [
  { name: "Overview", path: "/overview", endpoint: "/api/overview" },
  { name: "Direction", path: "/direction", endpoint: "/api/direction" },
  { name: "Pending decisions", path: "/decisions", endpoint: "/api/proposals" },
  { name: "Work map", path: "/work", endpoint: "/api/work-map" },
  { name: "Graph", path: "/graph?node=RPT-01", endpoint: "/api/graph" },
  { name: "Analysis coverage", path: "/coverage", endpoint: "/api/overview" },
  { name: "Context", path: "/context" },
  { name: "Review", path: "/review" },
  { name: "Review history", path: "/reviews", endpoint: "/api/reviews" },
  { name: "Search", path: "/search?q=RPT-01", endpoint: "/api/search" },
  { name: "Entity detail", path: "/entity/RPT-01", endpoint: "/api/entity/RPT-01" },
  { name: "Review detail", path: "/reviews/REVIEW_ID", endpoint: "/api/reviews/REVIEW_ID" },
] as const;
const EMPTY_PAGES = [
  { name: "Pending decisions", route: "/decisions" }, { name: "Work map", route: "/work" },
  { name: "Graph", route: "/graph" }, { name: "Review history", route: "/reviews" },
  { name: "Search", route: "/search?q=NO-SUCH-ENTITY" }, { name: "Entity detail", route: "/entity/NO-SUCH-ENTITY" },
  { name: "Review detail", route: "/reviews/no-such-review" },
] as const;
const FORM_REQUESTS = [
  { name: "Context", route: "/context", path: "/api/context", input: "Task", button: "Compile context", busy: "Compiling…" },
  { name: "Review", route: "/review", path: "/api/review", input: "Task (optional)", button: "Review changes", busy: "Reviewing…" },
] as const;

type Status = "통과" | "제품 문제" | "도구 오류" | "미검증";
interface Finding { readonly status: Status; readonly detail: string }
interface CaseResult {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly screen: string;
  readonly state: string;
  readonly theme?: string;
  readonly viewport?: string;
  readonly status: Status;
  readonly screenshot?: string;
  readonly additionalScreenshots?: string[];
  readonly documentScrollWidth?: number;
  readonly documentClientWidth?: number;
  readonly graphScrollWidth?: number;
  readonly graphClientWidth?: number;
  readonly violations?: unknown[];
  readonly incomplete?: unknown[];
  readonly supplementalTableRules?: { readonly explicitlyEnabled: readonly string[]; readonly violations: unknown[]; readonly incomplete: unknown[] };
  readonly findings?: Finding[];
  readonly attempts?: readonly { readonly attemptIndex: number; readonly error: SerializedAuditError; readonly cleanupErrors?: readonly { readonly phase: string; readonly error: SerializedAuditError }[] }[];
  readonly toolErrors?: readonly { readonly phase: string; readonly error: SerializedAuditError }[];
  readonly steps?: readonly AuditStep[];
  readonly blockedBy?: { readonly caseId: string; readonly reason: string };
  readonly error?: SerializedAuditError;
}
interface AuditStep {
  readonly stepIndex: number;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly url: string;
  readonly activeElementId: string;
  readonly dialogState: string;
  readonly judgment: Status;
  readonly screenshot?: string;
}

class AuditToolError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "AuditToolError"; }
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function focusSnapshot(page: Page): Promise<{ readonly target: string; readonly focusVisible: boolean; readonly indicatorVisible: boolean; readonly unobscured: boolean; readonly inViewport: boolean }> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return { target: "none", focusVisible: false, indicatorVisible: false, unobscured: false, inViewport: false };
    const body = element === document.body;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    let withinScrollClips = true;
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/u.test(`${overflow.overflowX} ${overflow.overflowY}`)) {
        const bounds = parent.getBoundingClientRect();
        withinScrollClips &&= rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom;
      }
    }
    const target = body ? "BODY" : element instanceof HTMLAnchorElement ? `a:${element.getAttribute("href")}` :
      element instanceof HTMLButtonElement ? `button:${element.getAttribute("aria-label") || element.textContent?.trim()}` :
        element.tagName === "SUMMARY" ? `summary:${element.textContent?.trim()}` : `${element.tagName}:${element.id || element.getAttribute("data-testid") || "unidentified"}`;
    return { target, focusVisible: body || element.matches(":focus-visible"),
      indicatorVisible: body || style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
      unobscured: body || (top === element || element.contains(top)) && withinScrollClips,
      inViewport: body || rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight };
  });
}

const runsDir = path.join(ROOT, ".duo-a11y-runs");
const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${process.pid}`;
const outputDir = path.join(runsDir, runId);
const casesPath = path.join(outputDir, "cases.jsonl");
const summaryPath = path.join(outputDir, "summary.json");
const require = createRequire(import.meta.url);
const axeCorePath = require.resolve("axe-core", { paths: [path.dirname(require.resolve("@axe-core/playwright"))] }) as string;
const axeCore = require(axeCorePath) as { getRules: () => { tags: string[] }[] };
const axeVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(axeCorePath), "package.json"), "utf8")) as { version: string };
const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
const temps: string[] = [];
const servers: DuoUiServer[] = [];
const contexts: BrowserContext[] = [];
const serverByContext = new Map<BrowserContext, DuoUiServer>();
const pendingCleanupErrors: { phase: string; error: SerializedAuditError }[] = [];
const recordedIds = new Set<string>();
const recordedResults: CaseResult[] = [];
let registry: AnalyzerRegistry;
let browser: Browser | undefined;
let browserName = "unavailable";
let browserVersion = "unavailable";
let fixtureRoot = "";
let emptyFixtureRoot = "";
let reviewId = "";
let activeAttemptIndex = 1;
const proposalIds: string[] = [];
let runSummary: Record<string, unknown> = {};

function record(result: CaseResult): void {
  storeAuditRecord(outputDir, sanitizeAuditArtifact(result) as CaseResult & AuditRecord, recordedIds);
  recordedResults.push(result);
}

function saveLocalDiagnostics(): void {
  if (process.env.DUO_A11Y_LOCAL_DIAGNOSTICS !== "1") return;
  const directory = path.join(runsDir, "local-diagnostics", runId);
  fs.mkdirSync(directory, { recursive: true });
  atomicWriteJson(path.join(directory, "summary.json"), runSummary);
  for (const result of recordedResults) atomicWriteJson(path.join(directory, `${result.id.replaceAll(/[^\w.-]/gu, "_")}.json`), result);
}

function tempRepo(): { root: string; index: () => Promise<void> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-a11y-")
  ));
  temps.push(root);
  fs.cpSync(path.join(FIXTURES, "review/app"), root, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "DUO Accessibility Audit", GIT_AUTHOR_EMAIL: "a11y@duo.invalid",
    GIT_COMMITTER_NAME: "DUO Accessibility Audit", GIT_COMMITTER_EMAIL: "a11y@duo.invalid" };
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, env, windowsHide: true, stdio: "pipe" });
  runGit("-c", "init.defaultBranch=main", "init", "-q");
  runGit("config", "core.autocrlf", "false");
  runGit("add", "-A");
  runGit("commit", "-qm", "accessibility audit fixture");
  const reportPath = path.join(root, "src", "report", "build-report.ts");
  fs.writeFileSync(reportPath, fs.readFileSync(reportPath, "utf8").replace("Math.floor(cents / 100)", "Math.round(cents / 100)"));
  return { root, index: async () => {
    const opened = openProjectGraphStore(root).value;
    if (opened === undefined) throw new Error("Could not open the fixture graph store");
    try { await indexRepository(root, { store: opened, registry }); } finally { opened.close(); }
  } };
}

async function launchBrowser(): Promise<Browser> {
  const failures: string[] = [];
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      const launched = await chromium.launch({ channel, headless: true });
      browserName = channel;
      browserVersion = launched.version();
      return launched;
    } catch (error) { failures.push(`${channel}: ${String(error)}`); }
  }
  try {
    const launched = await chromium.launch({ headless: true });
    browserName = "playwright chromium";
    browserVersion = launched.version();
    return launched;
  } catch (error) {
    failures.push(`playwright chromium: ${String(error)}`);
    throw new Error(`No audit browser could be launched. ${failures.join(" | ")}`, { cause: error });
  }
}

async function openPage(route: string, viewport: { width: number; height: number } = VIEWPORTS[0], colorScheme: "light" | "dark" = "light", root = fixtureRoot):
Promise<{ context: BrowserContext; page: Page; server: DuoUiServer }> {
  if (browser === undefined) throw new Error("Audit browser is unavailable");
  let server: DuoUiServer | undefined;
  let context: BrowserContext | undefined;
  let isolatedRoot = "";
  try {
    isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-a11y-case-"));
    fs.cpSync(root, isolatedRoot, { recursive: true });
    temps.push(isolatedRoot);
    server = await startDuoUiServer({ root: isolatedRoot, version: "ui-a11y-audit", registry, llm: new LLMProviderPool({}) });
    servers.push(server);
    context = await browser.newContext({ viewport, colorScheme });
    contexts.push(context);
    serverByContext.set(context, server);
    const page = await context.newPage();
    await page.goto(server.launchUrl);
    const url = new URL(route, server.origin);
    await page.goto(url.href);
    return { context, page, server };
  } catch (error) {
    if (context !== undefined) await closeContext(context).catch(() => undefined);
    else if (server !== undefined) {
      await server.close().catch(() => undefined);
      const serverIndex = servers.indexOf(server);
      if (serverIndex >= 0) servers.splice(serverIndex, 1);
    }
    if (server === undefined && isolatedRoot !== "") { try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* Preserve route setup error. */ } }
    throw new AuditToolError(`Could not open audit route ${route}`, { cause: error });
  }
}

async function closeContext(context: BrowserContext): Promise<void> {
  try { await context.close(); } catch (error) { pendingCleanupErrors.push({ phase: "context.close", error: serializeAuditError(error) }); }
  const contextIndex = contexts.indexOf(context);
  if (contextIndex >= 0) contexts.splice(contextIndex, 1);
  const server = serverByContext.get(context);
  serverByContext.delete(context);
  if (server !== undefined) {
    try { await server.close(); } catch (error) { pendingCleanupErrors.push({ phase: "server.close", error: serializeAuditError(error) }); }
    const serverIndex = servers.indexOf(server);
    if (serverIndex >= 0) servers.splice(serverIndex, 1);
  }
}

function verifyAxeTags(): void {
  const available = axeCore.getRules().flatMap((rule) => rule.tags);
  const missing = TAGS.filter((tag) => !available.includes(tag));
  if (missing.length > 0) throw new Error(`Configured axe tags are unsupported: ${missing.join(", ")}`);
}

function expectedCaseIds(): string[] {
  return [
    ...PAGES.flatMap((screen) => SCHEMES.flatMap((scheme) => VIEWPORTS.map((viewport) => `base-${screen.name}-${scheme}-${viewport.name}`))),
    ...PAGES.map((screen) => `support-${screen.name}`),
    ...PAGES.flatMap((screen) => "endpoint" in screen ? ["로딩", "API 오류"].map((state) => `${state}-${screen.name}`) : []),
    ...EMPTY_PAGES.map((screen) => `empty-${screen.name}`),
    ...FORM_REQUESTS.flatMap((form) => ["로딩", "API 오류"].map((state) => `post-${state}-${form.name}`)),
    ...["context", "review", "search", "graph"].map((form) => `form-${form}-validation`),
    "keyboard-navigation", "modal-keyboard",
    ...["Confirm…", "Reject…"].flatMap((action) => SCHEMES.flatMap((scheme) => VIEWPORTS.flatMap((viewport) => {
      const id = `modal-${action.startsWith("Confirm") ? "confirm" : "reject"}-${scheme}-${viewport.name}`;
      return [id, `${id}-escape-focus`];
    }))),
    "workmap-keyboard", "form-work-add", "form-work-validation",
    ...["context", "review", "search", "graph"].map((form) => `form-${form}`),
  ];
}

function readCaseResults(): CaseResult[] {
  return [...recordedResults];
}

async function auditPage(page: Page, id: string, screen: string, state: string, theme?: string, viewport?: string, extraFindings: Finding[] = [], additionalScreenshots: string[] = []): Promise<CaseResult> {
  try { return await collectAuditPage(page, id, screen, state, theme, viewport, extraFindings, additionalScreenshots); }
  catch (error) { throw new AuditToolError(`Could not capture accessibility results for ${id}`, { cause: error }); }
}

async function collectAuditPage(page: Page, id: string, screen: string, state: string, theme?: string, viewport?: string, extraFindings: Finding[] = [], additionalScreenshots: string[] = []): Promise<CaseResult> {
  const screenshot = path.join(outputDir, id.replaceAll(/[^\w.-]/gu, "_"), `attempt-${activeAttemptIndex}`, "step-1.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
  const dimensions = await page.evaluate(() => {
    const graph = document.querySelector<HTMLElement>(".work-canvas");
    return { documentScrollWidth: document.documentElement.scrollWidth, documentClientWidth: document.documentElement.clientWidth,
      ...(graph === null ? {} : { graphScrollWidth: graph.scrollWidth, graphClientWidth: graph.clientWidth }) };
  });
  const axe = await new AxeBuilder({ page }).withTags([...TAGS]).analyze();
  const tableAxe = await new AxeBuilder({ page }).withRules(["td-has-header", "td-headers-attr", "th-has-data-cells", "scope-attr-valid", "empty-table-header"]).analyze();
  const findings: Finding[] = [...extraFindings];
  const structureSnapshot = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]), select, textarea")];
    const unnamedInputs = controls.filter((control) => {
      const ariaLabel = control.getAttribute("aria-label")?.trim();
      const referencedLabel = control.getAttribute("aria-labelledby")?.split(/\s+/u).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
      const associatedLabel = [...(control.labels ?? [])].some((label) => label.textContent?.trim());
      const imageAlt = control instanceof HTMLInputElement && control.type === "image" ? control.alt.trim() : "";
      return !ariaLabel && !referencedLabel && !associatedLabel && !imageAlt && !control.title.trim();
    }).length;
    const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].map((heading) => Number(heading.tagName.slice(1)));
    const skippedHeadingLevels = headings.slice(1).filter((level, index) => level > headings[index]! + 1).length;
    const tables: AuditTableSnapshot[] = [...document.querySelectorAll("table")].map((table) => ({
      role: table.getAttribute("role"),
      complex: [...table.querySelectorAll("[rowspan], [colspan]")].some((cell) => Number(cell.getAttribute("rowspan") ?? 1) > 1 || Number(cell.getAttribute("colspan") ?? 1) > 1),
      headerIds: [...table.querySelectorAll("th")].map((header) => header.id).filter(Boolean),
      cells: [...table.querySelectorAll("td")].map((cell) => {
        const references = cell.getAttribute("headers")?.split(/\s+/u).filter(Boolean) ?? [];
        const row = cell.parentElement;
        const hasRowHeader = [...(row?.querySelectorAll("th") ?? [])].some((header) =>
          header.getAttribute("scope") === "row" || (header.getAttribute("scope") !== "col" && header.cellIndex < cell.cellIndex));
        const hasColumnHeader = [...table.querySelectorAll("tr")].some((headerRow) => [...headerRow.querySelectorAll("th")]
          .some((header) => header.cellIndex === cell.cellIndex && header.getAttribute("scope") !== "row"));
        return { headers: references, hasRowHeader, hasColumnHeader };
      }),
    }));
    return { title: document.title.trim(), h1: document.querySelectorAll("h1").length,
      main: document.querySelectorAll("main, [role='main']").length, unnamedInputs,
      tables,
      skippedHeadingLevels };
  });
  const structure = { ...structureSnapshot, tables: structureSnapshot.tables.map((table) => assessTable(table)) };
  if (!structure.title || structure.h1 !== 1 || structure.main !== 1 || structure.unnamedInputs > 0 || structure.tables.some((table) => table.missingHeaders) || structure.skippedHeadingLevels > 0) {
    findings.push({ status: "제품 문제", detail: `Document structure assertion: ${JSON.stringify(structure)}` });
  }
  if (structure.tables.some((table) => table.kind === "complex")) findings.push({ status: "미검증", detail: `Complex table associations require manual review: ${JSON.stringify(structure.tables.filter((table) => table.kind === "complex"))}` });
  if (dimensions.documentScrollWidth > dimensions.documentClientWidth) findings.push({ status: "제품 문제", detail: "Document has horizontal overflow" });
  if (dimensions.graphScrollWidth !== undefined && dimensions.graphClientWidth !== undefined && dimensions.graphScrollWidth > dimensions.graphClientWidth) {
    findings.push({ status: "미검증", detail: "Work graph content overflows its own canvas; inspect screenshot and assess expected graph panning" });
  }
  if (axe.violations.length > 0) findings.push({ status: "제품 문제", detail: `${axe.violations.length} axe violation(s)` });
  if (tableAxe.violations.length > 0) findings.push({ status: "제품 문제", detail: `${tableAxe.violations.length} supplemental table rule violation(s)` });
  if (axe.incomplete.length > 0) findings.push({ status: "미검증", detail: `${axe.incomplete.length} axe incomplete item(s) require manual review` });
  findings.push({ status: "미검증", detail: "Review screenshot for overlap, truncation, and focus obstruction; no manual visual review has been recorded" });
  const status: Status = findings.some((f) => f.status === "제품 문제") ? "제품 문제" : findings.some((f) => f.status === "미검증") ? "미검증" : "통과";
  const result: CaseResult = { schemaVersion: 2, id, screen, state, ...(theme === undefined ? {} : { theme }), ...(viewport === undefined ? {} : { viewport }), status,
    screenshot: path.relative(ROOT, screenshot).replaceAll("\\", "/"), ...(additionalScreenshots.length === 0 ? {} : { additionalScreenshots }), ...dimensions,
    violations: axe.violations, incomplete: axe.incomplete, supplementalTableRules: { explicitlyEnabled: ["td-has-header", "td-headers-attr", "th-has-data-cells", "scope-attr-valid", "empty-table-header"], violations: tableAxe.violations, incomplete: tableAxe.incomplete }, findings,
    steps: [{ stepIndex: 1, expected: "Capture current DOM state and accessibility results", actual: { violationCount: axe.violations.length, incompleteCount: axe.incomplete.length, structure }, url: page.url(),
      activeElementId: await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (element === null) return "none";
        if (element.id) return `#${element.id}`;
        if (element.getAttribute("data-testid")) return `data-testid:${element.getAttribute("data-testid")}`;
        if (element instanceof HTMLAnchorElement) return `a:${element.getAttribute("href") || element.textContent?.trim() || "unnamed"}`;
        if (element instanceof HTMLButtonElement) return `button:${element.getAttribute("aria-label") || element.textContent?.trim() || "unnamed"}`;
        if (element.tagName === "SUMMARY") return `summary:${element.textContent?.trim() || "unnamed"}`;
        return element.tagName.toLowerCase();
      }),
      dialogState: await page.getByRole("dialog").count() > 0 ? "open" : "closed", judgment: status, screenshot: path.relative(ROOT, screenshot).replaceAll("\\", "/") }] };
  return result;
}

async function waitForLoadedScreen(page: Page): Promise<boolean> {
  if (!await appears(page.getByRole("heading", { level: 1 }))) return false;
  try {
    await page.waitForFunction(() => !/Loading/u.test(document.body.innerText), undefined, { timeout: 20_000 });
    return true;
  } catch (error) { if (isPlaywrightTimeout(error)) return false; throw error; }
}

async function appears(locator: ReturnType<Page["locator"]>, timeout = 20_000): Promise<boolean> {
  try { await locator.waitFor({ state: "visible", timeout }); return true; }
  catch (error) { if (error instanceof Error && error.name !== "TimeoutError") throw error; return false; }
}

async function executeCase(id: string, screen: string, state: string, action: () => Promise<CaseResult>): Promise<CaseResult> {
  let attemptContexts = new Set<BrowserContext>();
  let attemptCleanupStart = 0;
  let failureScreenshot: string | undefined;
  const lifecycle = await runAuditLifecycle<CaseResult>({
    run: async (attemptIndex) => {
      activeAttemptIndex = attemptIndex;
      attemptContexts = new Set(contexts);
      attemptCleanupStart = pendingCleanupErrors.length;
      return action();
    },
    cleanup: async (attemptIndex) => {
      await Promise.all(contexts.filter((context) => !attemptContexts.has(context)).map((context) => closeContext(context)));
      return pendingCleanupErrors.splice(attemptCleanupStart).map((item) => ({ ...item, phase: `attempt-${attemptIndex}:${item.phase}` }));
    },
    onError: async (error, attemptIndex) => {
      if (attemptIndex !== 2 || !isPlaywrightTimeout(error)) return;
      const failedContext = contexts.find((context) => !attemptContexts.has(context));
      const failedPage = failedContext?.pages().at(-1);
      if (failedPage === undefined) return;
      const screenshotPath = path.join(outputDir, id.replaceAll(/[^\w.-]/gu, "_"), `attempt-${attemptIndex}`, "failure.png");
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      try { await failedPage.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }); failureScreenshot = path.relative(ROOT, screenshotPath).replaceAll("\\", "/"); }
      catch { /* Keep the original error when screenshot capture is unavailable. */ }
    },
  });
  const returned = lifecycle.result;
  const attempts = lifecycle.attempts;
  const finalToolErrors = lifecycle.toolErrors;
  const findings = [...(returned?.findings ?? [])];
  const status: Status = finalToolErrors.length > 0 ? "도구 오류" : returned?.status ?? "도구 오류";
  const result: CaseResult = { ...(returned ?? {}), schemaVersion: 2, id, screen, state, status,
    ...(attempts.length === 0 ? {} : { attempts }),
    ...(finalToolErrors.length === 0 ? {} : { toolErrors: finalToolErrors }),
    ...(attempts.length > 0 && returned === undefined ? { error: attempts.at(-1)!.error } : {}),
    ...(failureScreenshot === undefined || returned?.screenshot !== undefined ? {} : { screenshot: failureScreenshot }),
    findings };
  record(result);
  return result;
}

beforeAll(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const gitValue = (args: string[]) => { try { return git(args); } catch (error) { return `unavailable: ${String(error)}`; } };
  runSummary = {
    runId, startedAt: new Date().toISOString(),
    gitCommit: gitValue(["rev-parse", "HEAD"]),
    node: process.version, pnpm: /(?:^| )pnpm\/([^ ]+)/u.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "11.25.0 (packageManager pin)",
    playwright: (JSON.parse(fs.readFileSync(require.resolve("playwright-core/package.json"), "utf8")) as { version: string }).version,
    axeCore: axeVersion.version, browser: { name: browserName, version: browserVersion }, fixture: { status: "preparing" },
    schemaVersion: 3, configuredTags: TAGS, additionalTableRules: ["td-has-header (explicitly enabled)", "td-headers-attr", "th-has-data-cells", "scope-attr-valid", "empty-table-header"],
    outcomes: { passed: 0, productIssues: 0, toolErrors: 0, unverified: 0 }, setupComplete: false,
  };
  writeAuditSummary(summaryPath, sanitizeAuditArtifact(runSummary));
  saveLocalDiagnostics();
  try {
    verifyAxeTags();
    const created = await createDefaultAnalyzerRegistry();
    if (created.value === undefined) throw new Error("Could not initialize source analyzers");
    registry = created.value;
    browser = await launchBrowser();
    runSummary = { ...runSummary, browser: { name: browserName, version: browserVersion } };
    const repo = tempRepo();
    fixtureRoot = repo.root;
    const emptyRepo = tempRepo();
    emptyFixtureRoot = emptyRepo.root;
    await emptyRepo.index();
    const decisions = createDecisionService({ root: fixtureRoot });
    for (const title of ["Accessibility proposal one", "Accessibility proposal two"]) {
      const proposal = await decisions.propose({ kind: "agent", name: "audit" }, { title, question: `a11y_${proposalIds.length}`, answer: "fixture" });
      if (proposal.value?.proposalId === undefined) throw new Error(`Could not create ${title}`);
      proposalIds.push(proposal.value.proposalId);
    }
    await repo.index();
    const graph = openProjectGraphStore(fixtureRoot).value;
    if (graph === undefined) throw new Error("Could not open graph for review detail fixture");
    try {
      const review = await reviewChanges(fixtureRoot, { task: "RPT-01", diff: { from: "HEAD", to: "WORKTREE" } }, { graph, registry });
      if (review.value === undefined) throw new Error("Could not create review detail fixture");
      const recorded = await recordReview(review.value.result, { root: fixtureRoot, actor: { kind: "human", name: "Audit" }, clock: () => new Date("2026-10-21T00:00:00.000Z") });
      if (recorded.value?.id === undefined) throw new Error(`Could not persist review detail fixture: ${JSON.stringify(recorded.diagnostics)}`);
      reviewId = recorded.value.id;
    } finally { graph.close(); }
    const workMap = await import("../../packages/integration/src/http/work-map.js");
    const task = workMap.touchWorkTask(fixtureRoot, "Audit", "Keyboard graph selection", new Date(), { duoSessionId: "a11y-session", targetRef: "issue:AUTH-7" });
    if (task === undefined) throw new Error("Could not create Work map fixture task");
    runSummary = { ...runSummary, fixture: { status: "ready", source: "fixtures/review/app", generatedFiles: ["index DB", "two pending proposals", "one recorded review", "one work task"] }, setupComplete: true };
    writeAuditSummary(summaryPath, sanitizeAuditArtifact(runSummary));
  } catch (error) {
    record({ schemaVersion: 2, id: "audit-setup", screen: "감사 준비", state: "fixture/browser setup", status: "도구 오류", error: serializeAuditError(error) });
    runSummary = { ...runSummary, setupComplete: false, setupError: serializeAuditError(error) };
    writeAuditSummary(summaryPath, sanitizeAuditArtifact(runSummary));
    throw error;
  }
}, 300_000);

afterAll(async () => {
  const finalCleanupErrors: { phase: string; error: SerializedAuditError }[] = [];
  for (const context of [...contexts]) {
    try { await closeContext(context); } catch (error) { finalCleanupErrors.push({ phase: "context.close", error: serializeAuditError(error) }); }
  }
  for (const server of [...servers]) {
    try { await server.close(); } catch (error) { finalCleanupErrors.push({ phase: "server.close", error: serializeAuditError(error) }); }
  }
  try { await browser?.close(); } catch (error) { finalCleanupErrors.push({ phase: "browser.close", error: serializeAuditError(error) }); }
  try { registry?.dispose(); } catch (error) { finalCleanupErrors.push({ phase: "registry.dispose", error: serializeAuditError(error) }); }
  for (const temp of temps) {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (error) { finalCleanupErrors.push({ phase: "fixture.remove", error: serializeAuditError(error) }); }
  }
  finalCleanupErrors.push(...pendingCleanupErrors.splice(0));
  const results = readCaseResults();
  const outcomes = { passed: results.filter((r) => r.status === "통과").length, productIssues: results.filter((r) => r.status === "제품 문제").length,
    toolErrors: results.filter((r) => r.status === "도구 오류").length, unverified: results.filter((r) => r.status === "미검증").length };
  const ids = results.map((result) => result.id);
  const missingCases = expectedCaseIds().filter((id) => !ids.includes(id));
  const duplicateCases = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const casesWithProductFindings = results.filter((result) => result.findings?.some((finding) => finding.status === "제품 문제")).length;
  const casesWithToolErrors = results.filter((result) => (result.toolErrors?.length ?? 0) > 0 || result.status === "도구 오류").length;
  const casesWithUnverifiedFindings = results.filter(hasUnverifiedFindings).length;
  const executionComplete = runSummary.setupComplete === true && outcomes.toolErrors === 0 && finalCleanupErrors.length === 0 && missingCases.length === 0 && duplicateCases.length === 0;
  const accessibilityVerificationComplete = executionComplete && casesWithUnverifiedFindings === 0;
  runSummary = { ...runSummary, schemaVersion: 3, finishedAt: new Date().toISOString(), outcomes, casesWithProductFindings, casesWithToolErrors,
    casesWithUnverifiedFindings,
    globalCleanupErrors: finalCleanupErrors,
    caseCount: results.length, missingCases, duplicateCases, executionComplete, accessibilityVerificationComplete };
  for (const result of results) atomicWriteJson(path.join(outputDir, result.id.replaceAll(/[^\w.-]/gu, "_"), "result.json"), sanitizeAuditArtifact(result));
  atomicWriteText(casesPath, `${results.map((result) => JSON.stringify(sanitizeAuditArtifact(result))).join("\n")}\n`);
  writeAuditSummary(summaryPath, sanitizeAuditArtifact(runSummary));
  assertNoPrivatePathsInEvidence(summaryPath, casesPath, ROOT, os.homedir());
  expect(executionComplete, `Audit execution incomplete: ${JSON.stringify({ missingCases, duplicateCases, outcomes, finalCleanupErrors })}`).toBe(true);
});

describe("DUO UI accessibility audit 297", () => {
  it("audits every screen in light/dark themes at desktop/mobile sizes", async () => {
    const results: CaseResult[] = [];
    for (const screen of PAGES) {
      const route = screen.path.replace("REVIEW_ID", reviewId);
      for (const scheme of SCHEMES) for (const viewport of VIEWPORTS) {
        const id = `base-${screen.name}-${scheme}-${viewport.name}`;
        results.push(await executeCase(id, screen.name, "기본 데이터", async () => {
          const { context, page } = await openPage(route, viewport, scheme);
          verifyAxeTags();
          const loaded = await waitForLoadedScreen(page);
          const mapReady = screen.name !== "Work map" || await appears(page.locator(".work-summary"));
          const extra: Finding[] = loaded && mapReady ? [] : [{ status: "제품 문제", detail: JSON.stringify({ loaded, mapReady }) }];
          const result = await auditPage(page, id, screen.name, "기본 데이터", scheme, viewport.name, extra);
          await closeContext(context);
          return result;
        }));
      }
    }
    const failures = results.filter((r) => r.status === "도구 오류" || r.status === "제품 문제");
    expect(failures.filter((r) => r.status === "도구 오류").map((r) => ({ id: r.id, error: r.error }))).toEqual([]);
  }, 300_000);

  it("records applicable loading, empty and API error states", async () => {
    const results: CaseResult[] = [];
    for (const screen of PAGES) {
      const id = `support-${screen.name}`;
      const endpoint = "endpoint" in screen ? screen.endpoint : undefined;
      const formRequest = FORM_REQUESTS.find((form) => form.name === screen.name);
      const reason = endpoint === undefined
        ? formRequest === undefined ? "No initial API request; no separate asynchronous initial state applies." : "Initial state is form-only; POST loading/error are audited in dedicated cases."
        : "Loading and error are supported by the screen's asynchronous API read.";
      const status: Status = "통과";
      const support: CaseResult = { schemaVersion: 2, id, screen: screen.name, state: `상태 지원 여부: ${reason}`, status,
        findings: [] };
      record(support); results.push(support);
      if (endpoint === undefined) continue;
      for (const state of ["로딩", "API 오류"] as const) {
        const caseId = `${state}-${screen.name}`;
        results.push(await executeCase(caseId, screen.name, state, async () => {
          const { context, page, server } = await openPage(screen.path.replace("REVIEW_ID", reviewId));
          const target = endpoint.replace("REVIEW_ID", reviewId);
          let release: (() => void) | undefined;
          const held = new Promise<void>((resolve) => { release = resolve; });
          await page.route(`**${target}*`, async (intercept) => {
            if (state === "로딩") { await held; await intercept.continue(); }
            else await intercept.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "AUDIT_TEST_ERROR", message: "Audit fixture error" } }) });
          });
          await page.goto(new URL(screen.path.replace("REVIEW_ID", reviewId), server.origin).href);
          verifyAxeTags();
          try {
            if (state === "로딩") {
              const loadingVisible = await appears(page.getByRole("status"));
              const loadingResult = await auditPage(page, caseId, screen.name, state, undefined, undefined,
                loadingVisible ? [] : [{ status: "제품 문제", detail: "The delayed API request did not expose an announced loading state" }]);
              release?.();
              return loadingResult;
            }
            const errorVisible = await appears(page.getByRole("alert"));
            const extra: Finding[] = errorVisible ? [] : [{ status: "제품 문제", detail: "The API failure did not produce an announced error message" }];
            return await auditPage(page, caseId, screen.name, state, undefined, undefined, extra);
          } finally { release?.(); await closeContext(context); }
        }));
      }
    }
    for (const screen of EMPTY_PAGES) {
      const caseId = `empty-${screen.name}`;
      results.push(await executeCase(caseId, screen.name, "빈 데이터", async () => {
        const { context, page } = await openPage(screen.route, VIEWPORTS[0], "light", emptyFixtureRoot);
        const loaded = await waitForLoadedScreen(page);
        const result = await auditPage(page, caseId, screen.name, "빈 데이터", undefined, undefined,
          loaded ? [] : [{ status: "제품 문제", detail: "The empty-state page did not finish rendering its heading" }]);
        await closeContext(context); return result;
      }));
    }
    for (const form of FORM_REQUESTS) for (const state of ["로딩", "API 오류"] as const) {
      const caseId = `post-${state}-${form.name}`;
      results.push(await executeCase(caseId, form.name, `폼 제출 ${state}`, async () => {
        const { context, page } = await openPage(form.route);
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        await page.route(`**${form.path}*`, async (intercept) => {
          if (state === "로딩") { await held; await intercept.abort(); }
          else await intercept.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "AUDIT_TEST_ERROR", message: "Audit fixture error" } }) });
        });
        try {
          await page.getByLabel(form.input).fill("RPT-01");
          await page.getByRole("button", { name: form.button }).click();
          const expectedVisible = state === "로딩"
            ? await appears(page.getByRole("button", { name: form.busy }))
            : await appears(page.getByRole("alert"));
          const extra: Finding[] = expectedVisible ? [] : [{ status: "제품 문제",
            detail: `Form submit did not show the expected ${state === "로딩" ? "busy state" : "announced error"}` }];
          return await auditPage(page, caseId, form.name, `폼 제출 ${state}`, undefined, undefined, extra);
        } finally {
          release?.();
          await closeContext(context);
        }
      }));
    }
    expect(results.filter((r) => r.status === "도구 오류").map((r) => ({ id: r.id, error: r.error }))).toEqual([]);
  }, 300_000);

  it("checks keyboard navigation, modal behavior, forms and the Work map", async () => {
    await executeCase("keyboard-navigation", "Global navigation", "처음 Tab부터 순차 이동", async () => {
      const { context, page, server } = await openPage("/overview");
      if (!await waitForLoadedScreen(page)) {
        const result = await auditPage(page, "keyboard-navigation", "Global navigation", "키보드 순차 탐색",
          undefined, undefined, [{ status: "제품 문제", detail: "Overview did not finish rendering before keyboard navigation" }]);
        await closeContext(context); return result;
      }
      const navPage = await context.newPage();
      await navPage.goto(new URL("/overview", server.origin).href);
      await navPage.keyboard.press("Tab");
      const navFirst = await navPage.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href"));
      const expectedNavigation = ["/overview", "/direction", "/decisions", "/work", "/graph", "/coverage", "/context", "/review", "/reviews", "/search"];
      const actualNavigation: string[] = [];
      for (let index = 0; index < expectedNavigation.length; index++) {
        await navPage.keyboard.press("Tab");
        actualNavigation.push(await navPage.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href") ?? "unidentified"));
      }
      await navPage.keyboard.press("Enter");
      await navPage.waitForURL(/\/search$/u, { timeout: 5_000 }).catch(() => undefined);
      const navigationPass = navFirst === "#main" && actualNavigation.length === expectedNavigation.length && actualNavigation.every((href, index) => href === expectedNavigation[index]) && new URL(navPage.url()).pathname === "/search";
      const expectedOverviewSequence = ["button:Refresh", "a:/entity/M1", "a:/decisions", `a:/reviews/${reviewId}`, "summary:Analysis coverage", "a:/coverage", "summary:Declared knowledge gaps (1)"];
      const controlHtml = `<!doctype html><html><head><title>Normal HTML focus control</title></head><body><main id="main" tabindex="-1">
        <button type="button">Refresh</button><a href="/entity/M1">M1</a><a href="/decisions">Pending decisions</a>
        <a href="/reviews/${reviewId}">Review record</a><details open><summary>Analysis coverage</summary></details>
        <a href="/coverage">Coverage</a><details open><summary>Declared knowledge gaps (1)</summary></details>
      </main></body></html>`;
      const expectedControlForward = [...expectedOverviewSequence, "BODY"];
      const expectedControlReverse = [...expectedOverviewSequence].reverse();
      const viewportResults: { viewport: string; first: string; skipLinkPass: boolean; focusPass: boolean; mainFocused: boolean;
        forward: readonly string[]; reverse: readonly string[]; forwardComparison: ReturnType<typeof compareFocusSequence>;
        reverseComparison: ReturnType<typeof compareFocusSequence>; pageBoundary: string;
        controlForward: readonly string[]; controlReverse: readonly string[]; controlForwardComparison: ReturnType<typeof compareFocusSequence>;
        controlReverseComparison: ReturnType<typeof compareFocusSequence>; boundaryMatchesControl: boolean; summarySpaceChanged: boolean; summaryRestored: boolean;
        sequencePass: boolean; focusScreenshots: string[] }[] = [];
      const focusScreenshots: string[] = [];

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(new URL("/overview", server.origin).href);
        if (!await waitForLoadedScreen(page)) throw new AuditToolError(`Overview did not load at ${viewport.name}`);
        await page.keyboard.press("Tab");
        const first = await focusSnapshot(page);
        const firstHref = await page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href"));
        const focusPass = first.focusVisible && first.indicatorVisible && first.unobscured && first.inViewport;
        const focusScreenshot = path.join(outputDir, "keyboard-navigation", `attempt-${activeAttemptIndex}`, `step-2-${viewport.name}.png`);
        fs.mkdirSync(path.dirname(focusScreenshot), { recursive: true });
        await page.screenshot({ path: focusScreenshot, fullPage: true, animations: "disabled" });
        focusScreenshots.push(path.relative(ROOT, focusScreenshot).replaceAll("\\", "/"));

        await page.keyboard.press("Enter");
        const mainFocused = await page.evaluate(() => document.activeElement?.id === "main");
        const tabSequence = [];
        for (let index = 0; index < expectedOverviewSequence.length; index++) {
          await page.keyboard.press("Tab");
          tabSequence.push(await focusSnapshot(page));
        }
        const actualForward = tabSequence.map((entry) => entry.target);
        const forwardComparison = compareFocusSequence(expectedOverviewSequence, actualForward);

        const summary = page.locator("summary").filter({ hasText: "Declared knowledge gaps" });
        const summaryWasOpen = await summary.evaluate((element) => element.parentElement?.hasAttribute("open") ?? false);
        await page.keyboard.press("Space");
        const summarySpaceChanged = await summary.evaluate((element) => !(element.parentElement?.hasAttribute("open") ?? false)) === summaryWasOpen;
        await page.keyboard.press("Space");
        const summaryRestored = await summary.evaluate((element) => element.parentElement?.hasAttribute("open") ?? false) === summaryWasOpen;
        await page.keyboard.press("Tab");
        const pageBoundary = (await focusSnapshot(page)).target;
        const reverseSequence = [];
        for (let index = 0; index < expectedOverviewSequence.length; index++) {
          await page.keyboard.press("Shift+Tab");
          reverseSequence.push(await focusSnapshot(page));
        }
        const actualReverse = reverseSequence.map((entry) => entry.target);
        const reverseComparison = compareFocusSequence([...expectedOverviewSequence].reverse(), actualReverse);
        const sequencePass = forwardComparison.pass && reverseComparison.pass && tabSequence.every((entry) =>
          entry.focusVisible && entry.indicatorVisible && entry.unobscured && entry.inViewport) && reverseSequence.every((entry) =>
          entry.focusVisible && entry.indicatorVisible && entry.unobscured && entry.inViewport);

        await navPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await navPage.setContent(controlHtml);
        await navPage.evaluate(() => document.getElementById("main")?.focus());
        const controlForward: string[] = [];
        for (let index = 0; index < expectedControlForward.length; index++) {
          await navPage.keyboard.press("Tab");
          controlForward.push((await focusSnapshot(navPage)).target);
        }
        const controlForwardComparison = compareFocusSequence(expectedControlForward, controlForward);
        const controlReverse: string[] = [];
        for (let index = 0; index < expectedControlReverse.length; index++) {
          await navPage.keyboard.press("Shift+Tab");
          controlReverse.push((await focusSnapshot(navPage)).target);
        }
        const controlReverseComparison = compareFocusSequence(expectedControlReverse, controlReverse);
        const boundaryMatchesControl = pageBoundary === controlForward.at(-1) && pageBoundary === "BODY";
        viewportResults.push({ viewport: viewport.name, first: first.target, skipLinkPass: firstHref === "#main", focusPass, mainFocused,
          forward: actualForward, reverse: actualReverse, forwardComparison, reverseComparison, pageBoundary,
          controlForward, controlReverse, controlForwardComparison, controlReverseComparison, boundaryMatchesControl,
          summarySpaceChanged, summaryRestored, sequencePass, focusScreenshots: [focusScreenshots.at(-1) ?? ""] });
      }

      const internalPass = viewportResults.every((result) => result.skipLinkPass && result.focusPass && result.mainFocused && result.sequencePass &&
        result.summarySpaceChanged && result.summaryRestored && result.controlForwardComparison.pass && result.controlReverseComparison.pass && result.boundaryMatchesControl);
      const extra: Finding[] = [
        ...(!navigationPass || !internalPass ? [{ status: "제품 문제" as const, detail: JSON.stringify({ expectedNavigation, actualNavigation, navigationPass, viewportResults }) }] : []),
        { status: "미검증", detail: "Browser UI focus leaving and returning was not observable; page-internal traversal and BODY boundary behavior were compared with a normal HTML control at desktop and mobile sizes." },
      ];
      const result = await auditPage(page, "keyboard-navigation", "Global navigation", "정방향·역방향 페이지 순서와 HTML 대조", undefined, undefined, extra,
        focusScreenshots);
      await closeContext(context);
      return { ...result, steps: [...(result.steps ?? []), { stepIndex: 2, expected: expectedNavigation,
        actual: { navFirst, actualNavigation, navigatedUrl: navPage.url() }, url: navPage.url(), activeElementId: "a:/search", dialogState: "closed",
        judgment: navigationPass ? "통과" : "제품 문제" }, { stepIndex: 3, expected: { forward: expectedOverviewSequence, reverse: [...expectedOverviewSequence].reverse() },
        actual: { viewports: viewportResults.map(({ viewport, forward, reverse, forwardComparison, reverseComparison, sequencePass }) =>
          ({ viewport, forward, reverse, forwardComparison, reverseComparison, sequencePass })) }, url: page.url(), activeElementId: "button:Refresh", dialogState: "closed",
        judgment: internalPass ? "통과" : "제품 문제", ...(result.screenshot === undefined ? {} : { screenshot: result.screenshot }) },
      { stepIndex: 4, expected: { controlForward: expectedControlForward, controlReverse: expectedControlReverse, browserUiBoundary: "manual evidence required" },
        actual: { viewports: viewportResults.map(({ viewport, pageBoundary, controlForward, controlReverse, controlForwardComparison, controlReverseComparison, boundaryMatchesControl }) =>
          ({ viewport, pageBoundary, controlForward, controlReverse, controlForwardComparison, controlReverseComparison, boundaryMatchesControl })), browserUiBoundaryObserved: false },
        url: page.url(), activeElementId: viewportResults.at(-1)?.pageBoundary ?? "none", dialogState: "closed", judgment: "미검증" } ] };
    });

    await executeCase("modal-keyboard", "Pending decisions", "Confirm·Reject 모달 포커스·순환·닫기", async () => {
      const checks: { action: string; pass: boolean; detail: unknown }[] = [];
      const screenshots: string[] = [];
      const steps: AuditStep[] = [];
      let last: { context: BrowserContext; page: Page } | undefined;
      let stepIndex = 2;
      const activeElementId = (page: Page) => page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (element === null) return "none";
        if (element.id) return `#${element.id}`;
        if (element.getAttribute("data-testid")) return `data-testid:${element.getAttribute("data-testid")}`;
        if (element instanceof HTMLAnchorElement) return `a:${element.getAttribute("href") || element.textContent?.trim() || "unnamed"}`;
        if (element instanceof HTMLButtonElement) return `button:${element.getAttribute("aria-label") || element.textContent?.trim() || "unnamed"}`;
        if (element.tagName === "SUMMARY") return `summary:${element.textContent?.trim() || "unnamed"}`;
        return element.tagName.toLowerCase();
      });
      const capture = async (page: Page, name: string, expected: string, actual: unknown, dialogState: string, judgment: Status) => {
        const screenshot = path.join(outputDir, "modal-keyboard", `attempt-${activeAttemptIndex}`, `step-${stepIndex}.png`);
        fs.mkdirSync(path.dirname(screenshot), { recursive: true });
        await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
        const relative = path.relative(ROOT, screenshot).replaceAll("\\", "/");
        screenshots.push(relative);
        steps.push({ stepIndex, expected, actual: { name, ...((typeof actual === "object" && actual !== null) ? actual : { value: actual }) }, url: page.url(),
          activeElementId: await activeElementId(page), dialogState, judgment, screenshot: relative });
        stepIndex++;
      };
      for (const spec of [{ action: "Confirm…", proposalIndex: 0, input: "input", submit: "Confirm" }, { action: "Reject…", proposalIndex: 1, input: "textarea", submit: "Reject" }] as const) {
        const opened = await openPage("/decisions");
        if (last !== undefined) await closeContext(last.context);
        last = opened;
        const { page } = opened;
        const proposalId = proposalIds[spec.proposalIndex] ?? "missing-proposal-fixture";
        const trigger = page.getByRole("article").filter({ hasText: proposalId }).getByRole("button", { name: spec.action });
        const loaded = await waitForLoadedScreen(page);
        let reachedTrigger = false;
        for (let index = 0; loaded && index < 40; index++) {
          if (await trigger.evaluate((element) => element === document.activeElement)) { reachedTrigger = true; break; }
          await page.keyboard.press("Tab");
        }
        if (reachedTrigger) await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: `${spec.submit} ${proposalId}?` });
        const openedDialog = reachedTrigger && await appears(dialog);
        if (!openedDialog) {
          checks.push({ action: spec.action, pass: false, detail: { loaded, reachedTrigger, openedDialog } });
          continue;
        }
        const initialFocus = await activeElementId(page);
        const submit = dialog.getByRole("button", { name: `${spec.submit} ${proposalId}` });
        const submitStateValid = spec.action === "Confirm…" ? await submit.isDisabled() : await submit.isEnabled();
        await capture(page, `${spec.action} open`, "Keyboard Enter opens a modal with initial field focus", { initialFocus, submitStateValid }, "open", initialFocus === spec.input && submitStateValid ? "통과" : "제품 문제");
        await page.keyboard.press("Shift+Tab");
        const reverseFirst = await activeElementId(page);
        await page.keyboard.press("Shift+Tab");
        const reverseSecond = await activeElementId(page);
        const reverseSecondCancel = await dialog.getByRole("button", { name: "Cancel" }).evaluate((element) => element === document.activeElement);
        await page.keyboard.press("Tab");
        const forwardFirst = await activeElementId(page);
        await page.keyboard.press("Tab");
        const forwardSecond = await activeElementId(page);
        let forwardThird: string | undefined;
        if (spec.action === "Reject…") {
          await page.keyboard.press("Tab");
          forwardThird = await activeElementId(page);
        }
        const cancelFocused = await dialog.getByRole("button", { name: "Cancel" }).evaluate((element) => element === document.activeElement);
        const cancelTarget = "button:Cancel";
        const submitTarget = `button:${spec.submit} ${proposalId}`;
        const cyclePass = reverseFirst === "body" && reverseSecond === cancelTarget && reverseSecondCancel && forwardFirst === spec.input &&
          (spec.action === "Confirm…" ? forwardSecond === cancelTarget : forwardSecond === submitTarget && forwardThird === cancelTarget) && cancelFocused;
        await capture(page, `${spec.action} cycle`, "BODY sentinel only at dialog boundary; all dialog controls form both Tab cycles", { reverseFirst, reverseSecond, reverseSecondCancel, forwardFirst, forwardSecond, forwardThird, cancelFocused }, "open", cyclePass ? "통과" : "제품 문제");
        await page.keyboard.press("Enter");
        const cancelled = !(await dialog.isVisible());
        const cancelReturned = await trigger.evaluate((element) => element === document.activeElement);
        await capture(page, `${spec.action} cancel`, "Cancel closes modal and restores the trigger", { cancelled, cancelReturned }, cancelled ? "closed" : "open", cancelled && cancelReturned ? "통과" : "제품 문제");
        await page.keyboard.press("Enter");
        const reopened = await appears(dialog);
        if (reopened) await page.keyboard.press("Escape");
        const closed = reopened && !(await dialog.isVisible());
        const escapeReturned = closed && await trigger.evaluate((element) => element === document.activeElement);
        await capture(page, `${spec.action} escape`, "Escape closes modal and restores the trigger", { reopened, closed, escapeReturned }, closed ? "closed" : "open", closed && escapeReturned ? "통과" : "제품 문제");
        checks.push({ action: spec.action, pass: initialFocus === spec.input && submitStateValid && cyclePass && cancelled && cancelReturned && reopened && closed && escapeReturned,
          detail: { initialFocus, submitStateValid, reverseFirst, reverseSecond, reverseSecondCancel, forwardFirst, forwardSecond, forwardThird, cancelFocused, cancelled, cancelReturned, reopened, closed, escapeReturned } });
      }
      if (last === undefined) throw new AuditToolError("Could not initialize modal keyboard audit");
      const extra: Finding[] = checks.every((check) => check.pass) ? [] : [{ status: "제품 문제", detail: JSON.stringify(checks) }];
      const result = await auditPage(last.page, "modal-keyboard", "Pending decisions", "모달 키보드 검사", undefined, undefined, extra, screenshots);
      await closeContext(last.context);
      return { ...result, steps: [...(result.steps ?? []), ...steps] };
    });

    for (const action of ["Confirm…", "Reject…"]) for (const scheme of SCHEMES) for (const viewport of VIEWPORTS) {
      const id = `modal-${action.startsWith("Confirm") ? "confirm" : "reject"}-${scheme}-${viewport.name}`;
      const openResult = await executeCase(id, "Pending decisions", "모달 열린 상태", async () => {
        const { context, page } = await openPage("/decisions", viewport, scheme);
        if (!await waitForLoadedScreen(page)) {
          const result = await auditPage(page, id, "Pending decisions", `모달 ${action}`, scheme, viewport.name,
            [{ status: "제품 문제", detail: "Pending decisions did not finish rendering before the modal trigger" }]);
          await closeContext(context); return result;
        }
        const proposalId = proposalIds[action.startsWith("Confirm") ? 0 : 1] ?? "missing-proposal-fixture";
        const trigger = page.getByRole("article").filter({ hasText: proposalId }).getByRole("button", { name: action });
        await trigger.click();
        const dialog = page.getByRole("dialog");
        if (!await appears(dialog)) {
          const result = await auditPage(page, id, "Pending decisions", `모달 ${action}`, scheme, viewport.name,
            [{ status: "제품 문제", detail: `${action} trigger did not open a dialog` }]);
          await closeContext(context); return result;
        }
        const activeInside = await dialog.evaluate((node) => node.contains(document.activeElement));
        let actionStateValid: boolean;
        if (action.startsWith("Confirm")) {
          const submit = dialog.getByRole("button", { name: `Confirm ${proposalId}` });
          const disabledInitially = await submit.isDisabled();
          const input = dialog.getByRole("textbox");
          await input.fill(proposalId);
          const enabledWithMatchingId = await submit.isEnabled();
          await input.fill("");
          actionStateValid = disabledInitially && enabledWithMatchingId && await submit.isDisabled();
        } else {
          const submit = dialog.getByRole("button", { name: `Reject ${proposalId}` });
          const reason = dialog.getByRole("textbox");
          actionStateValid = await submit.isEnabled() && await reason.getAttribute("required") === null;
        }
        const extra: Finding[] = activeInside && actionStateValid ? [] : [{ status: "제품 문제",
          detail: JSON.stringify({ action, activeInside, actionStateValid }) }];
        const result = await auditPage(page, id, "Pending decisions", `모달 ${action}`, scheme, viewport.name, extra);
        await closeContext(context); return result;
      });
      const escapeId = `${id}-escape-focus`;
      const openingBlocked = openResult.findings?.some((finding) => /did not finish rendering|did not open a dialog/u.test(finding.detail)) ?? false;
      await executeCase(escapeId, "Pending decisions", "Escape로 닫고 트리거에 포커스 복귀", async () => {
        if (openingBlocked) return { schemaVersion: 2, id: escapeId, screen: "Pending decisions", state: "Escape로 닫고 트리거에 포커스 복귀",
          status: "미검증", blockedBy: { caseId: id, reason: `${action} dialog could not be opened; Escape behavior was not reachable` },
          findings: [{ status: "미검증", detail: `Blocked by modal opening case ${id}` }] };
        const { page } = await openPage("/decisions", viewport, scheme);
        const proposalId = proposalIds[action.startsWith("Confirm") ? 0 : 1] ?? "missing-proposal-fixture";
        const trigger = page.getByRole("article").filter({ hasText: proposalId }).getByRole("button", { name: action });
        await trigger.click();
        const dialog = page.getByRole("dialog");
        if (!await appears(dialog)) return { schemaVersion: 2, id: escapeId, screen: "Pending decisions", state: "Escape로 닫고 트리거 포커스 복귀",
          status: "미검증", blockedBy: { caseId: id, reason: "Independent Escape context could not open dialog" },
          findings: [{ status: "미검증", detail: `Blocked by modal opening case ${id}` }] };
        const result = await auditPage(page, escapeId, "Pending decisions", "모달 열린 상태", scheme, viewport.name);
        const openShot = result.screenshot;
        await page.keyboard.press("Escape");
        const closed = !(await dialog.isVisible());
        const restored = await trigger.evaluate((element) => element === document.activeElement);
        const closedShot = path.join(outputDir, escapeId, `attempt-${activeAttemptIndex}`, "step-2.png");
        await page.screenshot({ path: closedShot, fullPage: true, animations: "disabled" });
        return { ...result, ...(openShot === undefined ? {} : { screenshot: openShot }),
          additionalScreenshots: [path.relative(ROOT, closedShot).replaceAll("\\", "/")],
          status: closed && restored ? result.status : "제품 문제",
          findings: [...(result.findings ?? []), ...(closed && restored ? [] : [{ status: "제품 문제" as const, detail: JSON.stringify({ closed, restored }) }])],
          steps: [
            { stepIndex: 1, expected: "Dialog open before Escape", actual: { open: true }, url: page.url(), activeElementId: "dialog", dialogState: "open", judgment: "통과",
              ...(openShot === undefined ? {} : { screenshot: openShot }) },
            { stepIndex: 2, expected: "Escape closes dialog and restores trigger", actual: { closed, restored }, url: page.url(),
              activeElementId: await trigger.evaluate((element) => (element as HTMLElement).id || element.tagName.toLowerCase()), dialogState: closed ? "closed" : "open",
              judgment: closed && restored ? "통과" : "제품 문제", screenshot: path.relative(ROOT, closedShot).replaceAll("\\", "/") },
          ] };
      });
    }

    await executeCase("workmap-keyboard", "Work map", "다른 노드 선택 후 상세 변경", async () => {
      const { context, page } = await openPage("/work");
      const loaded = await waitForLoadedScreen(page);
      const mapReady = loaded && await appears(page.locator(".work-summary"));
      if (!mapReady) {
        const result = await auditPage(page, "workmap-keyboard", "Work map", "다른 노드 선택 후 상세 변경",
          undefined, undefined, [{ status: "제품 문제", detail: "Work map did not finish rendering its graph" }]);
        await closeContext(context); return result;
      }
      const nodes = page.locator(".react-flow__node");
      await nodes.first().waitFor();
      const nodeCount = await nodes.count();
      const before = await page.locator(".work-detail h2").textContent();
      let focusedNode: { id: string; title: string } | undefined;
      for (let i = 0; i < 80; i++) {
        focusedNode = await page.evaluate(() => {
          const node = document.activeElement?.closest<HTMLElement>(".react-flow__node");
          if (node === null || node === undefined || node.classList.contains("work-node--task")) return undefined;
          return { id: node.dataset.id ?? "", title: node.querySelector<HTMLElement>(".work-node-title")?.textContent?.trim() ?? "" };
        });
        if (focusedNode !== undefined && focusedNode.id !== "" && focusedNode.title !== "") break;
        await page.keyboard.press("Tab");
      }
      if (focusedNode !== undefined) await page.keyboard.press("Enter");
      if (focusedNode !== undefined) {
        try { await page.waitForFunction(({ id, title }) => {
          const selectedNode = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((node) => node.dataset.id === id);
          return selectedNode?.classList.contains("selected") === true && document.querySelector(".work-detail h2")?.textContent?.trim() === title;
        }, { id: focusedNode.id, title: focusedNode.title }, { timeout: 5_000 }); } catch { /* Record the observed state below as a product finding. */ }
      }
      const after = await page.locator(".work-detail h2").textContent();
      const selected = focusedNode === undefined ? false : await page.locator(".react-flow__node").evaluateAll((elements, id) =>
        elements.some((element) => element.getAttribute("data-id") === id && element.classList.contains("selected")), focusedNode.id);
      const pass = nodeCount > 1 && focusedNode !== undefined && selected && after?.trim() === focusedNode.title && before !== after;
      const extra: Finding[] = pass ? [] : [{ status: "제품 문제", detail: JSON.stringify({ nodeCount, focusedNode, selected, before, after }) }];
      const result = await auditPage(page, "workmap-keyboard", "Work map", "노드 키보드 탐색", undefined, undefined, extra);
      await closeContext(context); return result;
    });

    const formResults: CaseResult[] = [];
    for (const spec of [
      { id: "form-context", route: "/context", label: "Context Inspector", input: "Task", button: "Compile context", value: "RPT-01", result: "status: ready" },
      { id: "form-review", route: "/review", label: "Review", input: "Task (optional)", button: "Review changes", value: "RPT-01", result: "Deterministic review:" },
      { id: "form-search", route: "/search", label: "Search", input: "Find", button: "Search", value: "RPT-01", result: "RPT-01" },
      { id: "form-graph", route: "/graph", label: "Graph", input: "Seed", button: "Explore", value: "RPT-01", result: "Seed" },
    ]) {
      formResults.push(await executeCase(spec.id, spec.label, "정상 제출", async () => {
        const { context, page } = await openPage(spec.route);
        const input = page.getByLabel(spec.input);
        await input.fill(spec.value);
        await page.getByRole("button", { name: spec.button }).click();
        let resultVisible: boolean;
        if (spec.id === "form-search") resultVisible = await appears(page.getByRole("link", { name: "RPT-01", exact: true }).first());
        else if (spec.id === "form-graph") resultVisible = await appears(page.getByRole("heading", { name: "Seed", level: 2, exact: true }));
        else resultVisible = await appears(page.getByText(spec.result, { exact: false }).first());
        const extra: Finding[] = resultVisible ? [] : [{ status: "제품 문제", detail: `Submitting ${spec.label} did not show the expected result` }];
        const result = await auditPage(page, spec.id, spec.label, "정상 제출", undefined, undefined, extra);
        await closeContext(context); return result;
      }));
    }
    formResults.push(await executeCase("form-context-validation", "Context Inspector", "빈 Task 제출 방지", async () => {
      const { context, page } = await openPage("/context");
      const loaded = await waitForLoadedScreen(page);
      const button = page.getByRole("button", { name: "Compile context" });
      const emptySubmitBlocked = loaded && await button.isDisabled();
      const result = await auditPage(page, "form-context-validation", "Context Inspector", "입력 검증",
        undefined, undefined, emptySubmitBlocked ? [] : [{ status: "제품 문제", detail: "Empty Context task can be submitted" }]);
      await closeContext(context); return result;
    }));
    formResults.push(await executeCase("form-review-validation", "Review", "Task 선택 입력 확인", async () => {
      const { context, page } = await openPage("/review");
      const loaded = await waitForLoadedScreen(page);
      const task = page.getByLabel("Task (optional)");
      const optional = loaded && await task.getAttribute("required") === null;
      if (loaded) await page.getByRole("button", { name: "Review changes" }).click();
      const resultVisible = loaded && await appears(page.getByText("Deterministic review:", { exact: false }).first());
      const extra: Finding[] = optional && resultVisible ? [] : [{ status: "제품 문제", detail: JSON.stringify({ loaded, optional, resultVisible }) }];
      const result = await auditPage(page, "form-review-validation", "Review", "선택 입력 생략 상태", undefined, undefined, extra);
      await closeContext(context); return result;
    }));
    formResults.push(await executeCase("form-search-validation", "Search", "공백 검색 no-op", async () => {
      const { context, page } = await openPage("/search");
      const loaded = await waitForLoadedScreen(page);
      if (loaded) { await page.getByLabel("Find").fill("   "); await page.getByRole("button", { name: "Search" }).click(); }
      const params = new URL(page.url()).searchParams;
      const unchanged = loaded && new URL(page.url()).pathname === "/search" && !params.has("q");
      const result = await auditPage(page, "form-search-validation", "Search", "입력 검증", undefined, undefined,
        unchanged ? [] : [{ status: "제품 문제", detail: `Whitespace-only search navigated to ${page.url()}` }]);
      await closeContext(context); return result;
    }));
    formResults.push(await executeCase("form-graph-validation", "Graph", "공백 Seed 탐색 방지", async () => {
      const { context, page } = await openPage("/graph");
      const loaded = await waitForLoadedScreen(page);
      if (loaded) { await page.getByLabel("Seed").fill("   "); await page.getByRole("button", { name: "Explore" }).click(); }
      const url = new URL(page.url());
      const unchanged = loaded && url.pathname === "/graph" && !url.searchParams.has("node");
      const promptVisible = loaded && await appears(page.getByText("Choose a seed:", { exact: false }));
      const result = await auditPage(page, "form-graph-validation", "Graph", "입력 검증", undefined, undefined,
        unchanged && promptVisible ? [] : [{ status: "제품 문제", detail: JSON.stringify({ url: url.href, promptVisible }) }]);
      await closeContext(context); return result;
    }));
    formResults.push(await executeCase("form-work-add", "Work map", "정상 제출", async () => {
      const { context, page } = await openPage("/work");
      const loaded = await waitForLoadedScreen(page);
      const mapReady = loaded && await appears(page.locator(".work-summary"));
      if (!mapReady) {
        const result = await auditPage(page, "form-work-add", "Work map", "정상 제출",
          undefined, undefined, [{ status: "제품 문제", detail: "Work map did not finish rendering before work submission" }]);
        await closeContext(context); return result;
      }
      await page.getByLabel("Work name").fill("Accessibility audit added work");
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/work-tasks" && response.request().method() === "POST", { timeout: 20_000 }).catch(() => undefined);
      await page.getByRole("button", { name: "Add work" }).click();
      const response = await responsePromise;
      const responseOk = response?.ok() ?? false;
      const addedWorkVisible = responseOk && await appears(page.getByText("Accessibility audit added work", { exact: false }).first());
      const extra: Finding[] = responseOk && addedWorkVisible ? [] : [{ status: "제품 문제",
        detail: JSON.stringify({ responseStatus: response?.status() ?? "no POST response", addedWorkVisible }) }];
      const result = await auditPage(page, "form-work-add", "Work map", "정상 제출", undefined, undefined, extra);
      await closeContext(context); return result;
    }));
    formResults.push(await executeCase("form-work-validation", "Work map", "필수 입력 검증", async () => {
      const { context, page } = await openPage("/work");
      const loaded = await waitForLoadedScreen(page);
      const mapReady = loaded && await appears(page.locator(".work-summary"));
      if (!mapReady) {
        const result = await auditPage(page, "form-work-validation", "Work map", "필수 입력 검증",
          undefined, undefined, [{ status: "제품 문제", detail: "Work map did not finish rendering before form validation" }]);
        await closeContext(context); return result;
      }
      const name = page.getByLabel("Work name");
      await page.getByRole("button", { name: "Add work" }).click();
      const invalid = await name.evaluate((element) => ({ missing: (element as HTMLInputElement).validity.valueMissing,
        focused: element === document.activeElement }));
      const extra: Finding[] = invalid.missing && invalid.focused ? [] : [{ status: "제품 문제",
        detail: `Empty required Work name did not block submission and focus the field: ${JSON.stringify(invalid)}` }];
      const result = await auditPage(page, "form-work-validation", "Work map", "필수 입력 검증", undefined, undefined, extra);
      await closeContext(context); return result;
    }));
    const results = readCaseResults();
    const caseIds = results.map((result) => result.id);
    const missing = expectedCaseIds().filter((id) => !caseIds.includes(id));
    const duplicates = [...new Set(caseIds.filter((id, index) => caseIds.indexOf(id) !== index))];
    const toolErrors = results.filter((result) => result.status === "도구 오류").map(({ id, error }) => ({ id, error }));
    expect({ missing, duplicates, toolErrors }).toEqual({ missing: [], duplicates: [], toolErrors: [] });
  }, 300_000);
});
