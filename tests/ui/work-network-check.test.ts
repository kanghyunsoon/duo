import { it, expect } from "vitest";
import { chromium } from "playwright-core";
import { createDefaultAnalyzerRegistry } from "@duo-director/analyzer";
import { LLMProviderPool, startDuoUiServer } from "@duo-director/integration";
import { touchWorkTask } from "../../packages/integration/src/http/work-map.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("recovers the real work map after a network interruption", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-network-check-"));
  fs.cpSync("fixtures/review/app", root, { recursive: true });
  const registry = (await createDefaultAnalyzerRegistry()).value!;
  const server = await startDuoUiServer({ root, version: "network-check", registry, llm: new LLMProviderPool({}) });
  let browser;
  if (process.env.CI !== undefined) browser = await chromium.launch({ headless: true });
  else {
    try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
    catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
  }
  const context = await browser.newContext();
  await context.addInitScript(() => window.localStorage.setItem("duo.ui.language", "en"));
  try {
    const page = await context.newPage();
    await page.goto(server.launchUrl);
    await page.goto(server.origin + "/work");
    await page.getByText("No recorded sessions yet.").waitFor();
    const started = Date.now();
    await context.setOffline(true);
    await page.getByText(/Live connection interrupted/).waitFor({ timeout: 15000 });
    console.log("RECONNECTING_MS", Date.now() - started);
    await page.getByText(/Unable to check for updates/).waitFor({ timeout: 20000 });
    console.log("STALE_WARNING_MS", Date.now() - started);
    const task = touchWorkTask(root, "Codex", "Offline change", new Date(), { duoSessionId: "offline-check" });
    expect(task).toBeDefined();
    expect(await page.getByText("Offline change").count()).toBe(0);
    const restored = Date.now();
    await context.setOffline(false);
    await page.getByText(/Unable to check for updates/).waitFor({ state: "hidden", timeout: 30000 });
    await page.getByText(/Live connection interrupted/).waitFor({ state: "hidden", timeout: 30000 });
    await page.getByText("[Codex] Offline change").first().waitFor({ timeout: 30000 });
    console.log("RECOVERED_MS", Date.now() - restored);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
    await server.closed;
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
