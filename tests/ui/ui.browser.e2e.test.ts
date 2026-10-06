/**
 * T18.1 browser E2E: the real local server and the bundled UI in a headless browser (the installed
 * pinned Playwright Chromium in CI, or installed Chrome/Edge locally). Skipped locally without a browser.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { captureAdoptionBaseline } from "@duo-director/director";
import { indexRepository, openProjectGraphStore } from "@duo-director/graph";
import { LLMProviderPool, startDuoUiServer, type DuoUiServer } from "@duo-director/integration";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const temps: string[] = [];
const servers: DuoUiServer[] = [];
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
  const page = await (browser as Browser).newPage();
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
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe("DUO UI in a browser (T18.1)", () => {
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
