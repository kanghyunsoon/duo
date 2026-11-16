/**
 * #40-1: characterize the install-time and agent-time PATH inputs before changing policy.
 * This is a reproduction of resolution, not a contract to keep the install-time choice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { checkLauncher, PATH_LAUNCHER } from "./launcher.js";

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

for (const [name, adapter] of [["codex", codexAdapter], ["claude-code", claudeCodeAdapter]] as const) {
  it(`#40-1 ${name}: the same configured command resolves differently inside and outside npm exec`, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-launcher-path-")));
    temps.push(root);
    const local = path.join(root, "node_modules", ".bin");
    const global = path.join(root, "global-bin");
    const executable = process.platform === "win32" ? "duoctl.cmd" : "duoctl";
    for (const [dir, version] of [[local, "0.3.3"], [global, "0.2.0"]] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, executable), `duoctl ${version}\n`, { mode: 0o755 });
    }
    const installer = {
      platform: process.platform,
      env: { PATH: [local, global].join(path.delimiter), PATHEXT: ".CMD;.EXE", npm_command: "exec" },
    };
    const agent = {
      platform: process.platform,
      env: { PATH: global, PATHEXT: ".CMD;.EXE" },
    };

    expect(adapter.plannedEntry(PATH_LAUNCHER).command).toBe("duoctl");
    expect(checkLauncher(root, PATH_LAUNCHER, installer)).toMatchObject({
      available: true, resolved: path.join(local, executable),
    });
    expect(checkLauncher(root, PATH_LAUNCHER, agent)).toMatchObject({
      available: true, resolved: path.join(global, executable),
    });
  });
}
