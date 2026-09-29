/** duoctl ui through the built CLI (subprocess, T18.1): starts, prints the local URL, serves the API, stops. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLI_MAIN, duoctl, existingProject } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function startUi(root: string, args: string[] = []): Promise<{ url: string; stop: () => Promise<number | null> }> {
  const child = spawn(process.execPath, [CLI_MAIN, "ui", ...args], { cwd: root, env: { ...process.env, DUO_LOCALE: "" }, windowsHide: true });
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL printed: ${out}`)), 60_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      const m = /DUO UI: (http:\/\/127\.0\.0\.1:\d+\/\?session=[\w-]+)/u.exec(out);
      if (m !== null) {
        clearTimeout(timer);
        resolve({ url: m[1] as string, stop: () => new Promise((done) => { child.once("exit", (code) => done(code)); child.kill(); }) });
      }
    });
    child.once("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
}

describe("duoctl ui (T18.1, subprocess)", () => {
  it("serves 127.0.0.1 on a free port; the printed link opens a session; the API answers; nothing is indexed or written", async () => {
    const p = existingProject(temps);
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const before = fs.readFileSync(`${p.root}/.duo-project/generated/index-state.json`, "utf8");
    const ui = await startUi(p.root);
    try {
      const launch = await fetch(ui.url, { redirect: "manual" });
      expect(launch.status).toBe(303);
      const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const overview = await fetch(new URL("/api/overview", ui.url), { headers: { Cookie: cookie } });
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({ format: "duo.ui.overview/1", data: { status: { project: { name: "orbit-tasks" }, llm: "disabled" } } });
      expect((await fetch(new URL("/api/overview", ui.url))).status).toBe(401);
      expect((await fetch(new URL("/assets/app.js", ui.url))).status).toBe(200);
    } finally {
      await ui.stop();
    }
    expect(fs.readFileSync(`${p.root}/.duo-project/generated/index-state.json`, "utf8")).toBe(before);
  });

  it("--port is used; --json does not apply; an uninitialized repository is refused", async () => {
    const p = existingProject(temps);
    expect(duoctl(p.root, ["ui"]).code).toBe(5);
    expect(duoctl(p.root, ["ui", "--json"]).code).toBe(1);
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    expect(duoctl(p.root, ["ui", "--port", "70000"]).code).toBe(1);
    const probe = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
    });
    const ui = await startUi(p.root, ["--port", String(probe)]);
    try {
      expect(new URL(ui.url).port).toBe(String(probe));
    } finally {
      await ui.stop();
    }
  });
});
