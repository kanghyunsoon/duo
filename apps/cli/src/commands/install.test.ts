import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "./shared.js";
import { installCommand } from "./install.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("install remove output", () => {
  it("says there is nothing to remove when the agent is not configured", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "duo-install-remove-"));
    roots.push(root);
    const env: Env = {
      root, json: false, locale: "en", nonInteractive: true, yes: true, verbose: false,
      io: { out: () => {}, err: () => {}, isTTY: false, prompt: async () => undefined, readStdin: async () => "", cwd: () => root, now: () => new Date(0), env: {} },
    };

    const result = await installCommand(env, "remove", "claude-code", {});

    expect(result.human).toContain("DUO is not configured for claude-code; nothing to remove.");
  });
});
