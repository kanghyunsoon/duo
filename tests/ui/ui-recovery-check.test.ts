import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import path from "node:path";

let browser: Browser;
let page: Page;
let response: { status: number; body: string };
const envelope = (data: unknown) => JSON.stringify({ format: "duo.ui.search/1", ok: true, data });

beforeAll(async () => {
  if (process.env.CI !== undefined) browser = await chromium.launch({ headless: true });
  else {
    try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
    catch { browser = await chromium.launch({ channel: "msedge", headless: true }); }
  }
  page = await browser.newPage();
  await page.addInitScript(() => window.localStorage.setItem("duo.ui.language", "en"));
  await page.route("http://duo-test.local/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: response.status, body: response.body, contentType: "application/json" });
      return;
    }
    const file = url.pathname.startsWith("/assets/") ? path.basename(url.pathname) : "index.html";
    await route.fulfill({ path: path.join("packages/ui/dist/app", file) });
  });
});
afterAll(async () => { await browser.close(); });

describe("UI response and recovery", () => {
  it("shows results and empty state", async () => {
    response = { status: 200, body: envelope({ candidates: [{ source: "truth", kind: "requirement", id: "AUTH-03", match: "auth" }] }) };
    await page.goto("http://duo-test.local/search?q=auth");
    await page.getByRole("link", { name: "AUTH-03" }).waitFor();
    response = { status: 200, body: envelope({ candidates: [] }) };
    await page.goto("http://duo-test.local/search?q=empty");
    await page.getByText("No match.", { exact: true }).waitFor();
  });
  it("identifies invalid response and keeps the alert accessible", async () => {
    for (const body of ["<html>", JSON.stringify({ format: "duo.ui.search/1", ok: true })]) {
      response = { status: 200, body };
      await page.goto("http://duo-test.local/search?q=broken");
      const alert = page.getByRole("alert");
      await alert.waitFor();
      expect(await alert.innerText()).toContain("The server response could not be read. Please try again.");
      expect(await page.locator("main").count()).toBe(1);
    }
  });
  it("explains session expiration", async () => {
    response = { status: 401, body: JSON.stringify({ ok: false, error: { code: "UI_SESSION_REQUIRED", message: "no session" } }) };
    await page.goto("http://duo-test.local/search?q=test");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.innerText()).toContain("Open the URL printed by duoctl ui");
  });
  it("exposes a dynamic request failure as an alert after a search is submitted", async () => {
    response = { status: 503, body: JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: "Service unavailable. Try again." } }) };
    await page.goto("http://duo-test.local/search");
    expect(await page.getByRole("alert").count()).toBe(0);
    await page.getByLabel("Find").fill("example");
    await page.getByRole("button", { name: "Search" }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.innerText()).toContain("Service unavailable. Try again.");
  });
  it("handles malformed and valid encoded entity addresses", async () => {
    await page.goto("http://duo-test.local/entity/%");
    await page.getByRole("heading", { name: "Invalid address" }).waitFor();
    expect(await page.getByRole("link", { name: "Go to Overview" }).count()).toBe(1);
    response = { status: 200, body: envelope({ status: "not-found", id: "한글 ID" }) };
    await page.goto("http://duo-test.local/entity/%ED%95%9C%EA%B8%80%20ID");
    await page.getByRole("heading", { name: "한글 ID" }).waitFor();
    await page.getByText(/is not a Truth definition/).waitFor();
  });
  it("recovers from a render exception and navigates to a different page", async () => {
    response = { status: 200, body: envelope({ candidates: {} }) };
    await page.goto("http://duo-test.local/search?q=broken");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.innerText()).toContain("Something went wrong displaying this page");
    response = { status: 200, body: envelope({ candidates: [] }) };
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByText("No match.", { exact: true }).waitFor();
    response = { status: 200, body: envelope({ candidates: {} }) };
    await page.goto("http://duo-test.local/search?q=broken");
    await page.getByRole("alert").waitFor();
    response = { status: 200, body: envelope({ candidates: [] }) };
    await page.getByRole("link", { name: "Search", exact: true }).first().click();
    await page.getByRole("heading", { name: "Search" }).waitFor();
    expect(await page.getByText("Page unavailable").count()).toBe(0);
  });
});
