/// <reference lib="dom" />
/** Bundled UI against mock HTTP data. No repository or Git state is created. Build the UI first. */
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: Server;
let origin: string;
let browser: Browser | undefined;
const assets = fileURLToPath(new URL("../../packages/ui/dist/app/", import.meta.url));

beforeAll(async () => {
  server = createServer((request, response) => {
    const name = request.url === "/assets/PretendardVariable.woff2" ? "PretendardVariable.woff2" : request.url === "/assets/app.js" ? "app.js" : request.url === "/assets/app.css" ? "app.css" : "index.html";
    response.setHeader("Content-Type", name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
    response.end(fs.readFileSync(`${assets}/${name}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  origin = `http://127.0.0.1:${address.port}`;
  if (process.env.CI !== undefined) browser = await chromium.launch({ headless: true });
  else for (const channel of ["chrome", "msedge"]) {
    try { browser = await chromium.launch({ channel, headless: true }); break; }
    catch { /* Try another installed browser. */ }
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function mock(page: Page) {
  await page.route("**/api/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (endpoint === "/api/session") data = { csrf: "test-csrf" };
    if (endpoint === "/api/proposals") data = { proposals: [{ id: "P-001", status: "pending", title: "Use DbClient", question: "database", answer: "DbClient", rationale: null,
      governs: { requirements: [], paths: [], symbols: [] }, proposedBy: "codex", proposedAt: null, supersedes: null, location: { path: "P-001.yaml" } }],
    previews: { "P-001": { sourceKind: "proposal", digest: "sha256:test", expectedDecisionId: "D-001", candidate: { title: "Use DbClient", question: "database", answer: "DbClient", forbids: { imported_paths: ["src/db/legacy-db.ts"] } } } } };
    if (endpoint === "/api/work-map") data = { format: "test", revision: "1", graphRevision: "1", indexStatus: "current", selectedTaskId: "1",
      nodes: [{ id: "task:1", type: "task", label: "[Codex] Original work", status: "active" }, { id: "file:1", type: "file", label: "src/a.ts", source: { path: "src/a.ts" } }],
      edges: [{ from: "task:1", to: "file:1", type: "WORK_CHANGED", source: "test" }], truncated: false };
    if (endpoint === "/api/work-events") { await route.fulfill({ contentType: "text/event-stream", body: "" }); return; }
    if (endpoint === "/api/reviews") data = { records: [], problems: [] };
    if (endpoint === "/api/search") data = { candidates: [] };
    if (endpoint === "/api/overview") data = {
      status: { project: { name: "Original project", vision: "VISION", currentMilestone: null }, truth: { requirements: 0, decisions: 0, constraints: 0, declaredGaps: 0 },
        index: { status: "current", changes: { files: 0, analysisStale: 0 }, fullRebuildReason: null }, baseline: null, pendingDecisions: [], llm: "disabled",
        analysis: { analyzerRegistryDigest: "test", files: { total: 1, structural: 0, fileOnly: 1 }, languages: [], fileOnly: { level: "L0", files: 1, extensions: [{ extension: "md", files: 1 }] } } },
      currentMilestone: null, requirements: { total: 0, byStatus: {} }, decisions: { active: 0, total: 0 }, declaredGaps: [], latestReview: null,
    };
    if (endpoint === "/api/direction") data = { vision: null, milestones: [], requirements: [], constraints: [], decisions: [], proposals: [] };
    if (endpoint === "/api/graph") data = { status: "found", nodes: [{ id: "REQ-001", type: "requirement", depth: 0 }], edges: [] };
    if (endpoint.startsWith("/api/entity/")) data = { status: "found", id: "REQ-001", type: "requirement", text: "Original Truth source" };
    if (endpoint.startsWith("/api/reviews/")) data = { status: "found", record: { id: "review-1", path: "reviews/review-1.yaml", body: { review: { verdict: "PASS" }, claims: [], evidence: [] } } };
    await route.fulfill({ json: { format: "test", ok: true, data } });
  });
}

it("switches language in place, preserves form input and persists across reloads", async (ctx) => {
  if (browser === undefined) return ctx.skip();
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await mock(page);
    await page.goto(`${origin}/search`);
    await page.getByRole("heading", { name: "검색", exact: true }).waitFor();
    await page.getByLabel("검색어", { exact: true }).fill("AUTH-03 original task");
    await page.getByLabel("언어", { exact: true }).selectOption("en");
    await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
    expect(await page.locator("form input").inputValue()).toBe("AUTH-03 original task");
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    expect(await page.title()).toBe("DUO — Project Direction Console");
    await page.reload();
    await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
    await page.getByLabel("Language", { exact: true }).selectOption("ko");
    await page.getByRole("heading", { name: "검색", exact: true }).waitFor();
    expect(await page.locator("html").getAttribute("lang")).toBe("ko");
    expect(await page.title()).toBe("DUO — 프로젝트 방향 콘솔");
    await page.getByRole("navigation").getByRole("link", { name: "결정 대기", exact: true }).click();
    await page.getByRole("button", { name: "확정…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("저장소 전체 (governs는 금지 범위를 제한하지 않습니다)", { exact: true }).waitFor();
    const confirm = dialog.getByRole("button", { name: "P-001 확정", exact: true });
    expect(await confirm.isDisabled()).toBe(true);
    await dialog.getByRole("textbox").fill("P-001");
    expect(await confirm.isEnabled()).toBe(true);
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await page.getByRole("navigation").getByRole("link", { name: "세션 파일", exact: true }).click();
    await page.locator(".session-graph-heading").filter({hasText:"변경한 파일"}).waitFor();
    await page.getByLabel("언어", { exact: true }).selectOption("en");
    await page.locator(".session-graph-heading").filter({hasText:"Changed files"}).waitFor();
    await page.getByRole("heading", { name: "Session files", exact: true }).waitFor();
    await page.locator(".session-add > summary").click();
    expect(await page.getByLabel("Work name", { exact: true }).count()).toBe(1);
    expect(errors).toEqual([]);
  } catch (error) { throw new Error(`${String(error)}\nUI: ${await page.locator("main").innerHTML()}\nErrors: ${errors.join("; ")}`, { cause: error }); } finally { await page.close(); }
}, 30_000);

it("renders every route in both languages with the bundled resources", async (ctx) => {
  if (browser === undefined) return ctx.skip();
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  try {
    await mock(page);
    const routes = [
      ["/overview", "개요", "Overview"], ["/direction", "프로젝트 방향", "Direction"],
      ["/decisions", "결정 대기", "Pending decisions"], ["/work", "세션 파일", "Session files"],
      ["/graph?node=REQ-001", "세션 파일", "Session files"], ["/coverage", "개요", "Overview"],
      ["/context", "세션 파일", "Session files"], ["/review", "리뷰", "Review"],
      ["/reviews", "리뷰 이력", "Review history"], ["/search?q=hello", "검색", "Search"],
      ["/entity/REQ-001", "REQ-001", "REQ-001"], ["/reviews/review-1", "리뷰 review-1", "Review review-1"],
    ] as const;
    for (const [route, korean, english] of routes) {
      await page.goto(`${origin}${route}`);
      await page.getByRole("heading", { name: korean, exact: true, level: 1 }).waitFor();
      await page.getByLabel("언어", { exact: true }).selectOption("en");
      await page.getByRole("heading", { name: english, exact: true, level: 1 }).waitFor();
      await page.getByLabel("Language", { exact: true }).selectOption("ko");
      await page.getByRole("heading", { name: korean, exact: true, level: 1 }).waitFor();
      if (route === "/work") {
        await page.getByRole("button", { name: "확대", exact: true }).waitFor();
        if (process.env.DUO_I18N_SCREENSHOT !== undefined) await page.screenshot({ path: process.env.DUO_I18N_SCREENSHOT, fullPage: true });
      }
    }
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

it("keeps Korean usable when browser storage is disabled", async (ctx) => {
  if (browser === undefined) return ctx.skip();
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  try {
    await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage disabled"); } }));
    await mock(page);
    await page.goto(`${origin}/search`);
    await page.getByRole("heading", { name: "검색", exact: true }).waitFor();
    await page.getByLabel("언어", { exact: true }).selectOption("en");
    await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  } finally { await page.close(); }
}, 30_000);


it("keeps sidebar navigation available when collapsed and persists the preference", async (ctx) => {
  if (browser === undefined) return ctx.skip();
  const page=await browser.newPage();
  try {
    await mock(page); await page.goto(`${origin}/search`);
    await page.getByRole("button",{name:"사이드바 접기",exact:true}).click();
    expect(await page.locator(".layout").getAttribute("class")).toContain("sidebar-collapsed");
    await page.getByRole("navigation").getByRole("link",{name:"세션 파일",exact:true}).click();
    await page.getByRole("heading",{name:"세션 파일",exact:true,level:1}).waitFor();
    await page.reload();
    await page.getByRole("button",{name:"사이드바 펼치기",exact:true}).waitFor();
    expect(await page.getByRole("navigation").getByRole("link",{name:"분석 범위",exact:true}).count()).toBe(0);
    expect(await page.getByRole("navigation").getByRole("link",{name:"컨텍스트",exact:true}).count()).toBe(0);
    expect(await page.getByRole("navigation").getByRole("link",{name:"그래프",exact:true}).count()).toBe(0);
    await page.getByRole("button",{name:"사이드바 펼치기",exact:true}).click();
    await page.getByLabel("언어",{exact:true}).waitFor();
  } finally {await page.close();}
});

it("uses explicit session file records and keeps supplied context separate", async (ctx) => {
  if (browser === undefined) return ctx.skip();
  const page=await browser.newPage();
  try {
    await mock(page);
    await page.route("**/api/work-map*",route=>route.fulfill({json:{format:"test",ok:true,data:{
      revision:"1",selectedTaskId:"1",nodes:[
        {id:"task:1",type:"task",label:"[Codex] Recorded work",status:"active",changedFiles:["src/changed.ts","src/changed.ts"],referencedFiles:["docs/reference.md"],providedContext:{recordedAt:"2026-11-13T00:00:00Z",items:[{ref:"src/supplied.ts",kind:"file",text:"Supplied but not proven read"}]}},
        {id:"file:unrelated",type:"file",label:"src/unrelated.ts",source:{path:"src/unrelated.ts"}}],
      edges:[{from:"task:1",to:"file:unrelated",type:"RELATED",source:"context"}],truncated:false}}}));
    await page.goto(`${origin}/work`);
    await page.locator(".session-file-node").first().waitFor();
    expect(await page.locator(".session-file-node").count()).toBe(2);
    expect(await page.locator(".react-flow__edge").count()).toBe(2);
    expect(await page.locator(".session-simple-graph").textContent()).not.toContain("unrelated.ts");
    expect(await page.locator(".session-simple-graph").textContent()).not.toContain("supplied.ts");
    await page.locator("details.section > summary").filter({hasText:"에이전트에게 제공된 컨텍스트"}).click();
    await page.getByText("Supplied but not proven read",{exact:true}).waitFor();
    expect(await page.locator(".provided-context").textContent()).toContain("src/supplied.ts");
  } finally {await page.close();}
});
