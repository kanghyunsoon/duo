/// <reference lib="dom" />

/**
 * T18.1 browser E2E: the real local server and the bundled UI in a headless browser (the installed
 * pinned Playwright Chromium in CI, or installed Chrome/Edge locally). Skipped locally without a browser.
 */
import { execFileSync } from "node:child_process";
import { AxeBuilder } from "@axe-core/playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService, definitionRef, nodeId } from "@duo-director/core";
import { captureAdoptionBaseline, recordReview, reviewChanges } from "@duo-director/director";
import { indexRepository, openProjectGraphStore } from "@duo-director/graph";
import { LLMProviderPool, startDuoUiServer, type DuoUiServer } from "@duo-director/integration";
import { completeWorkTask, recordWorkReview, touchWorkTask } from "../../packages/integration/src/http/work-map.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const temps: string[] = [];
const servers: DuoUiServer[] = [];
const contexts: BrowserContext[] = [];
let registry: AnalyzerRegistry;
let browser: Browser | undefined;

async function launch(): Promise<Browser | undefined> {
  if (process.env.CI !== undefined) {
    // CI installs the Playwright version's matching Chromium; absence is a test failure.
    return chromium.launch({ headless: true });
  }
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next installed browser
    }
  }
  return undefined;
}

function repo(fixture: string, extra: (root: string) => void = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-ui-e2e-")));
  temps.push(root);
  fs.cpSync(path.join(FIXTURES, fixture), root, { recursive: true });
  extra(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, env: gitEnv, windowsHide: true, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-qm", "init");
  const index = async () => {
    const store = openProjectGraphStore(root).value;
    if (store === undefined) throw new Error("graph");
    try { await indexRepository(root, { store, registry }); } finally { store.close(); }
  };
  const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
  const edit = (f: string, from: string, to: string) => write(f, fs.readFileSync(path.join(root, f), "utf8").replace(from, to));
  return { root, git, index, write, edit };
}

async function open(root: string): Promise<{ page: Page; server: DuoUiServer; foreign: string[]; errors: string[] }> {
  const server = await startDuoUiServer({ root, version: "e2e", registry, llm: new LLMProviderPool({}) });
  servers.push(server);
  const context = await (browser as Browser).newContext();
  contexts.push(context);
  const page = await context.newPage();
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith(server.origin)) foreign.push(r.url()); });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.launchUrl);
  return { page, server, foreign, errors };
}

const see = (page: Page, text: string | RegExp) => page.getByText(text).first().waitFor({ timeout: 30_000 });
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();

beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error("registry");
  registry = created.value;
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  for (const s of servers) await s.close();
  await Promise.all(servers.map((s) => s.closed));
  await new Promise<void>((resolve) => setImmediate(resolve));
  registry?.dispose();
  await Promise.all(temps.map((t) => fs.promises.rm(t, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })));
});

describe("DUO UI in a browser (T18.1)", () => {
  it("renders the work map from compact DUO graph data", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const r = repo("review/app");
    await r.index();
    const { page, server, errors } = await open(r.root);
    await page.goto(`${server.origin}/work`);
    await page.getByRole("heading", { name: "Work map", level: 1 }).waitFor();
    await page.getByLabel("Work name").fill("Refresh flow");
    await page.getByLabel("DUO Issue ID (optional)").fill("AUTH-7");
    await page.getByRole("button", { name: "Add work" }).click();
    await page.getByText("[Codex] Refresh flow").first().waitFor();
    await page.locator(".react-flow__node").filter({ hasText: "[Codex] Refresh flow" }).click();
    await page.getByRole("button", { name: "Mark completed" }).waitFor();
    const nodes = page.locator(".react-flow__node");
    const count = await nodes.count();
    expect(count).toBeGreaterThan(1);
    const graph = page.locator(".work-canvas");
    expect(await graph.count()).toBe(1);
    expect(await graph.getAttribute("role")).toBe("region");
    expect(await graph.getAttribute("aria-label")).toBe("Work and DUO relationship graph");
    const taskNode = page.getByRole("button", { name: /\[Codex\] Refresh flow/u });
    expect(await taskNode.count()).toBe(1);
    expect(await taskNode.getAttribute("aria-pressed")).toBe("true");
    const accessibleNode = page.getByRole("button", { name: /\[Codex\] Refresh flow/u }).first();
    expect(await accessibleNode.getAttribute("role")).toBe("button");
    expect(["true", "false"]).toContain(await accessibleNode.getAttribute("aria-pressed"));
    const accessibility = await new AxeBuilder({ page }).withRules(["nested-interactive"]).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(await page.getByText("Loading…").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("keeps mobile pages and Decision dialogs within the viewport", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const r = repo("review/app");
    const service = createDecisionService({ root: r.root });
    const proposalId = (await service.propose({ kind: "agent", name: "codex" }, {
      title: `Mobile layout ${"identifier".repeat(12)}`, question: "mobile_layout", answer: `private/path/${"x".repeat(160)}`,
    })).value?.proposalId;
    if (proposalId === undefined) throw new Error("Could not create mobile layout proposal");
    await r.index();
    const graph = openProjectGraphStore(r.root).value;
    if (graph === undefined) throw new Error("Could not open graph for mobile layout fixture");
    let reviewId: string;
    try {
      const review = await reviewChanges(r.root, { task: "RPT-01", diff: { from: "HEAD", to: "WORKTREE" } }, { graph, registry });
      if (review.value === undefined) throw new Error("Could not create mobile review fixture");
      const recorded = await recordReview(review.value.result, { root: r.root, actor: { kind: "human", name: "Mobile layout" }, clock: () => new Date("2026-10-22T00:00:00.000Z") });
      if (recorded.value?.id === undefined) throw new Error("Could not persist mobile review fixture");
      reviewId = recorded.value.id;
    } finally { graph.close(); }
    const server = await startDuoUiServer({ root: r.root, version: "e2e", registry, llm: new LLMProviderPool({}) });
    servers.push(server);
    const context = await (browser as Browser).newContext({ viewport: { width: 320, height: 800 }, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(server.launchUrl);
    const routes = ["/overview", "/direction", "/decisions", "/work", "/graph?node=RPT-01", "/coverage", "/context", "/review", "/reviews", "/search?q=RPT-01", "/entity/RPT-01", `/reviews/${reviewId}`];
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.emulateMedia({ colorScheme });
      for (const route of routes) {
        await page.goto(`${server.origin}${route}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.waitForFunction(() => !document.body.innerText.includes("Loading…"));
        const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: window.innerWidth,
          rootWidths: [document.documentElement, document.body, document.querySelector(".layout"), document.querySelector("main")].map((element) => element === null ? null : `${element.tagName}.${String(element.className)} ${element.getBoundingClientRect().width} rect ${element.scrollWidth}/${element.clientWidth}`),
          offenders: [...document.querySelectorAll<HTMLElement>("body *")].map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.right > window.innerWidth + 1 || rect.left < -1)
            .sort((a, b) => b.rect.right - a.rect.right).slice(0, 8)
            .map(({ element, rect }) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 50)} ${Math.round(rect.left)}..${Math.round(rect.right)} (${element.scrollWidth}/${element.clientWidth})`) }));
        expect(width.scroll, `${colorScheme} ${route} document width ${JSON.stringify(width)}`).toBeLessThanOrEqual(width.client);
      }

      await page.goto(`${server.origin}/decisions`);
      await page.getByRole("heading", { name: "Pending decisions", level: 1 }).waitFor();
      await page.waitForFunction(() => !document.body.innerText.includes("Loading…"));
      const card = page.getByRole("article").filter({ hasText: proposalId });
      expect(await card.count(), `${colorScheme} proposal card: ${(await page.locator("body").innerText()).slice(-700)}`).toBe(1);
      await card.getByRole("button", { name: "Confirm…" }).click();
      const confirm = page.getByRole("dialog", { name: `Confirm ${proposalId}?` });
      await confirm.waitFor();
      const confirmWidth = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
        dialog: document.querySelector("dialog[open]")?.getBoundingClientRect().width ?? 0 }));
      expect(confirmWidth.document, `${colorScheme} confirm document width`).toBeLessThanOrEqual(confirmWidth.viewport);
      expect(confirmWidth.dialog, `${colorScheme} confirm dialog width`).toBeLessThanOrEqual(288);
      await confirm.getByRole("button", { name: "Cancel" }).click();

      await card.getByRole("button", { name: "Reject…" }).click();
      const reject = page.getByRole("dialog", { name: `Reject ${proposalId}?` });
      await reject.waitFor();
      await reject.getByLabel("Reason (optional)").fill(`private/path/${"y".repeat(160)}`);
      const rejectWidth = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
        dialog: document.querySelector("dialog[open]")?.getBoundingClientRect().width ?? 0 }));
      expect(rejectWidth.document, `${colorScheme} reject document width`).toBeLessThanOrEqual(rejectWidth.viewport);
      expect(rejectWidth.dialog, `${colorScheme} reject dialog width`).toBeLessThanOrEqual(288);
      await reject.getByRole("button", { name: "Cancel" }).click();

      await page.setViewportSize({ width: 1280, height: 800 });
      for (const route of routes) {
        await page.goto(`${server.origin}${route}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.waitForFunction(() => !document.body.innerText.includes("Loading…"));
        const desktopWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(desktopWidth.scroll, `${colorScheme} 1280px ${route} document width`).toBeLessThanOrEqual(desktopWidth.client);
      }
    }

    await page.goto(`${server.origin}/decisions`);
    await page.getByRole("heading", { name: "Pending decisions", level: 1 }).waitFor();
    await page.getByRole("article").filter({ hasText: proposalId }).getByRole("button", { name: "Confirm…" }).click();
    const desktopDialogWidth = await page.locator("dialog[open]").evaluate((dialog) => dialog.getBoundingClientRect().width);
    expect(desktopDialogWidth).toBeLessThanOrEqual(720);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
    await context.close();
  });

  it("keeps Work map keyboard selection, detail and refresh state synchronized", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const r = repo("review/app");
    const first = touchWorkTask(r.root, "Codex", "Keyboard task Alpha", new Date("2026-10-22T00:00:00.000Z"), { duoSessionId: "keyboard-alpha" });
    const second = touchWorkTask(r.root, "Codex", "Keyboard task Beta", new Date("2026-10-22T00:00:01.000Z"), { duoSessionId: "keyboard-beta" });
    if (first === undefined || second === undefined) throw new Error("Could not create Work map keyboard fixtures");
    const { page, server, errors } = await open(r.root);
    await page.goto(`${server.origin}/work`);
    const nodes = page.locator(".react-flow__node");
    await nodes.first().waitFor();
    const taskA = nodes.filter({ hasText: "Keyboard task Alpha" });
    const taskB = nodes.filter({ hasText: "Keyboard task Beta" });
    const worktree = nodes.filter({ hasText: "Worktree ·" }).first();
    const taskAId = await taskA.getAttribute("data-id");
    const taskBId = await taskB.getAttribute("data-id");
    const worktreeId = await worktree.getAttribute("data-id");
    expect(taskAId).toBeTruthy();
    expect(taskBId).toBeTruthy();
    expect(worktreeId).toBeTruthy();
    const detail = page.locator(".work-detail h2");
    const taskATitle = "[Codex] Keyboard task Alpha";
    const taskBTitle = "[Codex] Keyboard task Beta";
    const worktreeTitle = await worktree.locator(".work-node-title").textContent();
    const expectDetail = async (title: string) => {
      const started = Date.now();
      const observed: { ms: number; title: string | null }[] = [];
      try {
        await expect.poll(async () => {
          const current = await detail.evaluateAll(([heading]) => heading?.textContent?.trim() ?? null);
          if (observed.at(-1)?.title !== current) observed.push({ ms: Date.now() - started, title: current });
          return current;
        }, { timeout: 30_000, interval: 100 }).toBe(title);
      } catch {
        const panel = page.locator(".work-detail");
        throw new Error(`Work map detail did not update: ${JSON.stringify({ expected: title, waitedMs: Date.now() - started, observed, panelCount: await panel.count(), body: (await page.locator("body").textContent())?.slice(-500), selected: await page.locator(".react-flow__node.selected").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-id"))), errors })}`);
      }
    };
    const isSelected = async (locator: typeof taskA) => locator.evaluate((node) => node.classList.contains("selected"));
    await expectDetail(taskBTitle);

    await page.getByLabel("Agent").focus();
    let reachedWorktree = false;
    for (let index = 0; index < 24; index++) {
      reachedWorktree = await worktree.evaluate((node) => node === document.activeElement);
      if (reachedWorktree) break;
      await page.keyboard.press("Tab");
    }
    expect(reachedWorktree).toBe(true);
    await expectDetail(taskBTitle);
    await page.keyboard.press("Enter");
    await expectDetail(worktreeTitle ?? "");
    await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
      .some((node) => node.dataset.id === id && node.classList.contains("selected")), worktreeId);

    await taskA.evaluate((node) => (node as HTMLElement).focus());
    await page.keyboard.press("Space");
    await expectDetail(taskATitle);
    await taskB.click();
    await expectDetail(taskBTitle);
    await worktree.click();
    await expectDetail(worktreeTitle ?? "");
    await page.locator(".work-connection").filter({ hasText: "Keyboard task Alpha" }).click();
    await expectDetail(taskATitle);

    await taskA.click();
    await worktree.click({ modifiers: ["Shift"] });
    await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
      .some((node) => node.dataset.id === id && node.classList.contains("selected")), worktreeId);
    const selectedIdsAfterMulti = await page.locator(".react-flow__node.selected").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-id")));
    expect(selectedIdsAfterMulti).toEqual(expect.arrayContaining([taskAId, worktreeId]));
    expect(await isSelected(taskA)).toBe(true);
    expect(await isSelected(worktree)).toBe(true);
    await expectDetail(worktreeTitle ?? "");
    await worktree.click({ modifiers: ["Shift"] });
    await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
      .some((node) => node.dataset.id === id && node.classList.contains("selected")), taskAId);
    expect(await isSelected(worktree)).toBe(false);
    await expectDetail(taskATitle);

    await page.locator(".work-canvas").click({ position: { x: 8, y: 8 } });
    await page.getByText("Select a node to inspect its source and links.").waitFor();
    await taskA.click();
    await expectDetail(taskATitle);
    recordWorkReview(r.root, "keyboard-alpha", first.id, { digest: "keyboard-refresh", verdict: "PASS", claimCount: 2 }, new Date("2026-10-22T00:00:02.000Z"));
    await page.getByRole("button", { name: "Refresh" }).click();
    await expectDetail(taskATitle);
    await page.getByText("Review PASS · 2 claims · keyboard-refresh").waitFor();
    expect(await isSelected(taskA)).toBe(true);

    completeWorkTask(r.root, first.id, new Date("2026-10-22T00:00:03.000Z"));
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.waitForFunction((id) => ![...document.querySelectorAll<HTMLElement>(".react-flow__node")]
      .some((node) => node.dataset.id === id), taskAId);
    await page.getByText("Select a node to inspect its source and links.").waitFor();
    expect(await page.locator(".react-flow__node").filter({ hasText: "Keyboard task Beta" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows live agent work, review, file changes and completion without refreshing", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const liveUpdateTimeoutMs = 30_000;
    const r = repo("review/app");
    await r.index();
    const { page, server, errors } = await open(r.root);
    const mapResponses: { at: number; revision: string | undefined; review: unknown; durationMs: number | undefined }[] = [];
    const revisionResponses: { at: number; revision: string | undefined; durationMs: number | undefined }[] = [];
    page.on("response", async (response) => {
      const endpoint = new URL(response.url()).pathname;
      if (!response.ok() || (endpoint !== "/api/work-map" && endpoint !== "/api/work-revision")) return;
      const result = await response.json().catch(() => undefined) as
        { data?: { revision?: string; nodes?: { type: string; review?: unknown }[] }; meta?: { durationMs?: number } } | undefined;
      if (result === undefined) return;
      if (endpoint === "/api/work-map") mapResponses.push({ at: Date.now(), revision: result.data?.revision,
        review: result.data?.nodes?.find((n) => n.type === "task")?.review, durationMs: result.meta?.durationMs });
      else revisionResponses.push({ at: Date.now(), revision: result.data?.revision, durationMs: result.meta?.durationMs });
    });
    await page.goto(`${server.origin}/work`);
    await see(page, "Add a work item to explore its DUO neighbourhood.");
    const session = "live-graph-session";
    const name = "Live graph probe";
    const targetRef = nodeId(definitionRef("issue", "AUTH-7"));
    const timings: Record<string, number> = {};
    const start = Date.now();
    const task = touchWorkTask(r.root, "Codex", name, new Date(), { duoSessionId: session, targetRef });
    expect(task).toBeDefined();
    const node = page.locator(".react-flow__node").filter({ hasText: `[Codex] ${name}` });
    try { await node.waitFor({ timeout: liveUpdateTimeoutMs }); }
    catch (error) {
      const currentMap = await page.evaluate("fetch('/api/work-map').then(r => r.json()).then(r => r.data)") as { nodes?: { type: string; label: string }[] };
      console.log(`WORK_MAP_TASK_DEBUG ${JSON.stringify({ mapResponses, revisionResponses,
        serverTask: currentMap.nodes?.find((n) => n.type === "task"), page: await page.locator(".work-page").textContent(), errors })}`);
      throw error;
    }
    timings.taskVisibleMs = Date.now() - start;
    await node.click();
    await page.locator(".work-detail").getByRole("heading", { name: `[Codex] ${name}` }).waitFor();
    expect(await page.locator(".work-detail").textContent()).toContain(targetRef);
    await page.evaluate(`(() => {
      const blankMs = [];
      let absentAt;
      const observer = new MutationObserver(() => {
        const present = document.querySelector(".react-flow__node") !== null;
        if (!present && absentAt === undefined) absentAt = performance.now();
        else if (present && absentAt !== undefined) { blankMs.push(performance.now() - absentAt); absentAt = undefined; }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.workGraphProbe = { blankMs, observer };
    })()`);

    const reviewStart = Date.now();
    recordWorkReview(r.root, session, task?.id ?? "", { digest: "live-graph-review", verdict: "ASK", claimCount: 2 }, new Date());
    try { await page.getByText("Review ASK · 2 claims").waitFor({ timeout: liveUpdateTimeoutMs }); }
    catch (error) {
      const currentMap = await page.evaluate("fetch('/api/work-map').then(r => r.json()).then(r => r.data)") as { nodes?: { type: string; review?: unknown }[] };
      const stored = JSON.parse(fs.readFileSync(path.join(r.root, ".duo-project/runtime/work-tasks.json"), "utf8")) as { tasks: { review?: unknown }[] };
      console.log(`WORK_MAP_REVIEW_DEBUG ${JSON.stringify({ mapResponses, revisionResponses,
        detail: await page.locator(".work-detail").textContent(), storedReview: stored.tasks[0]?.review,
        serverReview: currentMap.nodes?.find((n) => n.type === "task")?.review, errors })}`);
      throw error;
    }
    timings.reviewVisibleMs = Date.now() - reviewStart;

    const fileStart = Date.now();
    r.write("live-graph-probe.txt", "changed while the page is open\n");
    await page.locator(".react-flow__node").filter({ hasText: "live-graph-probe.txt" }).waitFor({ timeout: liveUpdateTimeoutMs });
    await page.getByText("Index stale").waitFor({ timeout: liveUpdateTimeoutMs });
    timings.fileVisibleMs = Date.now() - fileStart;
    const blankMs = await page.evaluate(`(() => {
      window.workGraphProbe?.observer.disconnect();
      return window.workGraphProbe?.blankMs ?? [];
    })()`) as number[];

    const completeStart = Date.now();
    completeWorkTask(r.root, task?.id ?? "", new Date());
    await node.waitFor({ state: "detached", timeout: liveUpdateTimeoutMs });
    timings.completedVisibleMs = Date.now() - completeStart;

    const sharedA = touchWorkTask(r.root, "Codex", "Shared review label\nvariant alpha", new Date(), { duoSessionId: session });
    const sharedB = touchWorkTask(r.root, "Codex", "Shared review label\nvariant beta", new Date(), { duoSessionId: session });
    expect(sharedA?.id).not.toBe(sharedB?.id);
    recordWorkReview(r.root, session, sharedA?.id ?? "", { digest: "digest-alpha", verdict: "PASS", claimCount: 1 }, new Date());
    recordWorkReview(r.root, session, sharedB?.id ?? "", { digest: "digest-beta", verdict: "BLOCK", claimCount: 2 }, new Date());
    const nodeA = page.locator(`.react-flow__node[data-id="task:${sharedA?.id}"]`);
    const nodeB = page.locator(`.react-flow__node[data-id="task:${sharedB?.id}"]`);
    await nodeA.waitFor({ timeout: liveUpdateTimeoutMs });
    await nodeB.waitFor({ timeout: liveUpdateTimeoutMs });
    await nodeA.click();
    await page.getByText("Review PASS · 1 claims · digest-alpha").waitFor({ timeout: liveUpdateTimeoutMs });
    await nodeB.click();
    await page.getByText("Review BLOCK · 2 claims · digest-beta").waitFor({ timeout: liveUpdateTimeoutMs });
    expect(mapResponses.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(0, ...blankMs)).toBeLessThan(500);
    expect(errors).toEqual([]);
    console.log(`WORK_MAP_LIVE_METRICS ${JSON.stringify({ ...timings, blankMs, mapResponses: mapResponses.length,
      revisionResponses: revisionResponses.length,
      maxMapDurationMs: Math.max(...mapResponses.map((r) => r.durationMs ?? 0)),
      maxRevisionDurationMs: Math.max(...revisionResponses.map((r) => r.durationMs ?? 0)) })}`);
  });

  it("supports keyboard skip navigation and native decision-dialog focus handling", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const r = repo("review/app");
    const service = createDecisionService({ root: r.root });
    const proposalId = (await service.propose(
      { kind: "agent", name: "codex" },
      { title: "Keyboard audit proposal", question: "keyboard_audit", answer: "test the dialog" },
    )).value?.proposalId ?? "";
    expect(proposalId).not.toBe("");
    await r.index();
    const { page, server, errors } = await open(r.root);

    // The skip link takes keyboard users directly to the page's focusable main landmark.
    const skip = page.getByRole("link", { name: "Skip to content" });
    await skip.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");

    // Normal navigation remains operable with Enter and exposes the destination as a real URL.
    const decisions = page.getByRole("navigation").getByRole("link", { name: "Pending decisions", exact: true });
    await decisions.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`${server.origin}/decisions`);

    const card = page.getByRole("article").filter({ hasText: proposalId });
    const confirm = card.getByRole("button", { name: "Confirm…" });
    await confirm.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Confirm ${proposalId}?` });
    await dialog.waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-describedby"))).toBe(`c-${proposalId}`);

    // Escape closes the modal without an action and returns keyboard focus to its trigger.
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Confirm…");
    expect(errors).toEqual([]);
  });

  it("overview, direction, context, review, confirm and reject, stale index and a deep link", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const r = repo("review/app");
    const service = createDecisionService({ root: r.root });
    const agent = { kind: "agent" as const, name: "codex" };
    const pa = (await service.propose(agent, { title: "Round reports half up", question: "report_rounding", answer: "round half up", governs: { requirements: ["RPT-01"] } })).value?.proposalId ?? "";
    const pb = (await service.propose(agent, { title: "Reports in cents", question: "report_unit", answer: "whole cents" })).value?.proposalId ?? "";
    await r.index(); // proposals are Project Truth files: index after writing them
    const { page, server, foreign, errors } = await open(r.root);

    await page.waitForURL(`${server.origin}/overview`);
    await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
    await see(page, "review-app");
    await see(page, "index current");
    await see(page, "LLM disabled (default): DUO works without it");
    expect(await page.getByRole("alert").count()).toBe(0);

    await nav(page, "Direction");
    await page.getByRole("link", { name: "RPT-01", exact: true }).first().waitFor();
    const d010 = page.getByRole("row").filter({ hasText: "D-010" }).first();
    expect(await d010.textContent()).toContain("CONFIRMED");

    await nav(page, "Context");
    await page.getByLabel("Task").fill("RPT-01");
    await page.getByRole("button", { name: "Compile context" }).click();
    await see(page, "status: ready");
    await see(page, "Packet tokens");

    await nav(page, "Review");
    await page.getByRole("button", { name: "Review changes" }).click();
    await see(page, "Deterministic review:");
    await see(page, "This review is not recorded");

    await nav(page, "Pending decisions");
    const card = page.getByRole("article").filter({ hasText: pa });
    await card.getByRole("button", { name: "Confirm…" }).click();
    const dialog = page.getByRole("dialog", { name: `Confirm ${pa}?` });
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: `Confirm ${pa}` }).isDisabled()).toBe(true);
    await dialog.getByRole("textbox").fill(pa);
    await dialog.getByRole("button", { name: `Confirm ${pa}` }).click();
    await see(page, new RegExp(`${pa} confirmed as D-\\d+`, "u"));
    const decisionId = /confirmed as (D-\d+)/u.exec((await page.getByRole("status").filter({ hasText: "confirmed as" }).first().textContent()) ?? "")?.[1] ?? "";
    await page.reload();
    await page.getByRole("heading", { name: "Pending decisions", level: 1 }).waitFor();
    // Read back from the server: the confirmed proposal left the pending list (its file is removed on commit).
    await page.getByRole("article").filter({ hasText: pb }).waitFor();
    expect(await page.getByRole("article").filter({ hasText: pa }).count()).toBe(0);

    await page.getByRole("article").filter({ hasText: pb }).getByRole("button", { name: "Reject…" }).click();
    const reject = page.getByRole("dialog", { name: `Reject ${pb}?` });
    await reject.getByLabel("Reason (optional)").fill("not now");
    await reject.getByRole("button", { name: `Reject ${pb}` }).click();
    await see(page, `${pb} rejected.`);
    await page.getByRole("heading", { name: "Pending decisions", level: 1 }).waitFor();
    expect(await page.getByRole("article").count()).toBe(0);
    await see(page, "No proposal is waiting for a human.");

    await nav(page, "Direction");
    const confirmedRow = page.getByRole("row").filter({ hasText: decisionId }).first();
    await confirmedRow.waitFor();
    expect(await confirmedRow.textContent()).toContain("CONFIRMED");

    // Stale index: the UI never indexes; the CLI (here: the indexer) does, and a Refresh shows it.
    r.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)");
    await nav(page, "Overview");
    await see(page, /Index required \(stale\)/u);
    await nav(page, "Context");
    await page.getByLabel("Task").fill("RPT-01");
    await page.getByRole("button", { name: "Compile context" }).click();
    await see(page, "index-required");
    await nav(page, "Review");
    await page.getByRole("button", { name: "Review changes" }).click();
    await see(page, "index-required");
    await r.index();
    await nav(page, "Overview");
    await page.getByRole("button", { name: "Refresh" }).click();
    await see(page, "index current");
    await nav(page, "Context");
    await page.getByLabel("Task").fill("RPT-01");
    await page.getByRole("button", { name: "Compile context" }).click();
    await see(page, "status: ready");

    // A deep link survives a refresh (the session is a cookie, not a URL fragment).
    await page.goto(`${server.origin}/entity/RPT-01`);
    await page.reload();
    await page.getByRole("heading", { name: "RPT-01", level: 1 }).waitFor();
    await see(page, "Definition source");

    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("existing project: pre-existing and introduced violations look different", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const legacy = "export class LegacySessionStore {\n  save(token: string): string {\n    return token;\n  }\n}\n";
    const r = repo("review/app", (root) => fs.writeFileSync(path.join(root, "src", "auth", "legacy-session-store.ts"), legacy));
    await r.index();
    const store = openProjectGraphStore(r.root).value;
    if (store === undefined) throw new Error("graph");
    try {
      const captured = await captureAdoptionBaseline(r.root, { graph: store, registry, actor: { kind: "human", name: "Ada" } });
      expect(captured.value?.status).toBe("captured");
    } finally {
      store.close();
    }
    r.edit("src/auth/legacy-session-store.ts", "return token;", "return token.trim();");
    r.write("src/auth/server-session-store.ts", "export class ServerSessionStore {\n  keep(token: string): string {\n    return token;\n  }\n}\n");
    await r.index();
    const { page, errors } = await open(r.root);
    await nav(page, "Review");
    await page.getByLabel("Task (optional)").fill("AUTH-03");
    await page.getByRole("button", { name: "Review changes" }).click();
    await see(page, "Deterministic review:");
    const touched = page.getByRole("row").filter({ hasText: "in-adoption-baseline, touched" }).first();
    await touched.waitFor();
    expect(await touched.textContent()).not.toContain("blocking");
    const introduced = page.getByRole("row").filter({ hasText: "not-in-adoption-baseline" }).first();
    await introduced.waitFor();
    expect(await introduced.textContent()).toContain("blocking");
    expect(errors).toEqual([]);
  });

  it("polyglot coverage: TS L2, Java/C#/C++/Python L1, other files L0 file-level; LLM unavailable is plain state", async (ctx) => {
    if (browser === undefined) return ctx.skip();
    const r = repo("languages/polyglot", (root) => {
      fs.mkdirSync(path.join(root, ".duo-project"), { recursive: true });
      fs.writeFileSync(path.join(root, ".duo-project", "project.yaml"), "schema_version: 1\nname: storefront\nllm:\n  provider: openai-responses\n  model: gpt-test-model\n");
      fs.mkdirSync(path.join(root, "rules"), { recursive: true });
      fs.writeFileSync(path.join(root, "rules", "pricing.foo"), "rule discount\nend\n");
    });
    await r.index();
    const { page, errors } = await open(r.root);
    await see(page, "Semantic assistance unavailable · OPENAI_API_KEY is not set");
    expect(await page.getByRole("alert").count()).toBe(0);
    await nav(page, "Analysis coverage");
    const row = async (language: string) => (await page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: language, exact: true }) }).first().textContent()) ?? "";
    await page.getByRole("rowheader", { name: "typescript" }).waitFor();
    expect(await row("typescript")).toContain("L2 · partial semantics");
    for (const l of ["java", "csharp", "cpp", "python"]) expect(await row(l), l).toContain("L1 · structural");
    expect(await row("other files")).toContain("L0 · file-level analysis");
    expect(await row("other files")).toContain(".foo 1");
    expect(errors).toEqual([]);
  });
});
