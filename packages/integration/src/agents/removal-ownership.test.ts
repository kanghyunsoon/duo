import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_MARKERS, bridgeLines } from "./bridge.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { applyAgentIntegration, inspectAgentIntegration, planAgentIntegration, planAgentRemoval } from "./integration.js";
import { PATH_LAUNCHER } from "./launcher.js";
import { upsertBlock } from "./managed-block.js";

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());
const adapters = [codexAdapter, claudeCodeAdapter];

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-remove-ownership-")));
  temps.push(root);
  fs.mkdirSync(path.join(root, ".duo-project"));
  fs.writeFileSync(path.join(root, ".duo-project/project.yaml"), "");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "duoctl.cmd" : "duoctl"), "fixture", { mode: 0o755 });
  const host = { platform: process.platform, env: { PATH: bin, PATHEXT: ".CMD;.EXE" } };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, host, read, write };
}

describe("file ownership across install and remove (#104)", () => {
  for (const adapter of adapters) {
    const emptyConfig = adapter.id === "codex" ? "" : '{\n  "mcpServers": {}\n}\n';
    const record = `.duo-project/runtime/agent-integration/${adapter.id}.json`;

    it(`${adapter.id}: preserves an existing empty config and bridge through repeated install, update and remove`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, emptyConfig);
      f.write(adapter.bridgeTarget, "");
      const install = () => planAgentIntegration(f.root, adapter.id, { host: f.host });
      expect((await applyAgentIntegration(f.root, install())).diagnostics).toEqual([]);
      expect(install().noop).toBe(true);
      expect((await applyAgentIntegration(f.root, install())).value?.changed).toEqual([]);
      // Updating the bridge must not reclassify an existing file as DUO-created.
      f.write(adapter.bridgeTarget, f.read(adapter.bridgeTarget).replace("Before substantial work", "Before old work"));
      expect((await applyAgentIntegration(f.root, install())).diagnostics).toEqual([]);

      const removal = planAgentRemoval(f.root, adapter.id);
      expect(removal.willDelete).toEqual([]);
      expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
      expect(f.read(adapter.mcpTarget)).toBe(emptyConfig);
      expect(f.read(adapter.bridgeTarget)).toBe("");
      expect(inspectAgentIntegration(f.root, adapter.id).status).toBe("not-configured");
      expect(planAgentRemoval(f.root, adapter.id).noop).toBe(true);
      expect(fs.existsSync(path.join(f.root, record))).toBe(false);
    });

    it(`${adapter.id}: deletes files DUO created, even after a bridge update`, async () => {
      const f = fixture();
      const install = () => planAgentIntegration(f.root, adapter.id, { host: f.host });
      expect((await applyAgentIntegration(f.root, install())).diagnostics).toEqual([]);
      f.write(adapter.bridgeTarget, f.read(adapter.bridgeTarget).replace("Before substantial work", "Before old work"));
      expect((await applyAgentIntegration(f.root, install())).diagnostics).toEqual([]);
      const removal = planAgentRemoval(f.root, adapter.id);
      expect(removal.willDelete).toEqual([adapter.mcpTarget, adapter.bridgeTarget]);
      expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
      for (const rel of removal.willDelete) expect(fs.existsSync(path.join(f.root, rel))).toBe(false);
      expect(planAgentRemoval(f.root, adapter.id).noop).toBe(true);
    });

    it(`${adapter.id}: preserves existing files and deletes missing ones independently`, async () => {
      for (const existing of [adapter.mcpTarget, adapter.bridgeTarget]) {
        const f = fixture();
        f.write(existing, existing === adapter.mcpTarget ? emptyConfig : "");
        expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
        const removal = planAgentRemoval(f.root, adapter.id);
        expect(removal.willDelete).toEqual([existing === adapter.mcpTarget ? adapter.bridgeTarget : adapter.mcpTarget]);
        expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
        expect(f.read(existing)).toBe(existing === adapter.mcpTarget ? emptyConfig : "");
      }
    });

    it(`${adapter.id}: an older install without ownership evidence keeps empty files and warns`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, adapter.write(undefined, adapter.plannedEntry(PATH_LAUNCHER)) as string);
      f.write(adapter.bridgeTarget, upsertBlock(undefined, bridgeLines("duoctl"), BRIDGE_MARKERS));
      const plan = planAgentRemoval(f.root, adapter.id);
      expect(plan.willDelete).toEqual([]);
      expect(plan.warnings.join(" ")).toMatch(/ownership is unknown/u);
      expect((await applyAgentIntegration(f.root, plan)).diagnostics).toEqual([]);
      expect(f.read(adapter.mcpTarget)).toBe(emptyConfig);
      expect(f.read(adapter.bridgeTarget)).toBe("");
      expect(planAgentRemoval(f.root, adapter.id).noop).toBe(true);
    });

    it(`${adapter.id}: retains human additions to files originally created by DUO`, async () => {
      const f = fixture();
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      f.write(adapter.bridgeTarget, f.read(adapter.bridgeTarget) + "Human notes\n");
      const humanConfig = adapter.id === "codex" ? "# Human settings\n" : '{\n  "mcpServers": {},\n  "extra": true\n}\n';
      f.write(adapter.mcpTarget, adapter.write(humanConfig, adapter.plannedEntry(PATH_LAUNCHER)) as string);
      const removal = planAgentRemoval(f.root, adapter.id);
      expect(removal.willDelete).toEqual([]);
      expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
      expect(f.read(adapter.mcpTarget)).toBe(humanConfig);
      expect(f.read(adapter.bridgeTarget)).toBe("Human notes\n");
      // A later install sees these as user files, not a previous install's files.
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      expect(JSON.parse(f.read(record)).created).toEqual([]);
    });

    it(`${adapter.id}: invalid ownership data blocks install/remove and never authorizes a deletion`, async () => {
      const f = fixture();
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      const before = [f.read(adapter.mcpTarget), f.read(adapter.bridgeTarget)];
      for (const bad of ["{broken", "null", JSON.stringify({ format: "duo.agent-file-ownership/1", created: ["../user-file"] })]) {
        f.write(record, bad);
        for (const plan of [planAgentIntegration(f.root, adapter.id, { host: f.host }), planAgentRemoval(f.root, adapter.id)]) {
          expect(plan.applicable).toBe(false);
          expect((await applyAgentIntegration(f.root, plan)).value).toBeUndefined();
          expect([f.read(adapter.mcpTarget), f.read(adapter.bridgeTarget)]).toEqual(before);
        }
      }
    });

    it(`${adapter.id}: changing ownership after planning makes install and remove stale`, async () => {
      const f = fixture();
      const install = planAgentIntegration(f.root, adapter.id, { host: f.host });
      f.write(record, JSON.stringify({ format: "duo.agent-file-ownership/1", created: [] }));
      expect((await applyAgentIntegration(f.root, install)).diagnostics.map((d) => d.code)).toEqual(["AGENT_PLAN_STALE"]);
      expect(fs.existsSync(path.join(f.root, adapter.mcpTarget))).toBe(false);
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      const remove = planAgentRemoval(f.root, adapter.id);
      f.write(record, "{broken");
      expect((await applyAgentIntegration(f.root, remove)).diagnostics.map((d) => d.code)).toEqual(["AGENT_PLAN_STALE"]);
      expect(inspectAgentIntegration(f.root, adapter.id).status).toBe("configured");
    });

    it(`${adapter.id}: failure to persist ownership rolls back the install`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, emptyConfig);
      const rename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === path.join(f.root, record)) throw new Error("ownership write failure");
        return rename(from, to);
      });
      const applied = await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }));
      expect(applied.diagnostics.map((d) => d.code)).toEqual(["FILE_WRITE_ERROR"]);
      expect(f.read(adapter.mcpTarget)).toBe(emptyConfig);
      expect(fs.existsSync(path.join(f.root, adapter.bridgeTarget))).toBe(false);
      expect(fs.existsSync(path.join(f.root, record))).toBe(false);
    });

    it(`${adapter.id}: failure to retire ownership restores the removed files and the record`, async () => {
      const f = fixture();
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      const before = [f.read(adapter.mcpTarget), f.read(adapter.bridgeTarget), f.read(record)];
      const rm = fsp.rm;
      vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
        if (target === path.join(f.root, record)) throw new Error("ownership removal failure");
        return rm(target, options);
      });
      const applied = await applyAgentIntegration(f.root, planAgentRemoval(f.root, adapter.id));
      expect(applied.diagnostics.map((d) => d.code)).toEqual(["FILE_WRITE_ERROR"]);
      expect([f.read(adapter.mcpTarget), f.read(adapter.bridgeTarget), f.read(record)]).toEqual(before);
      expect(inspectAgentIntegration(f.root, adapter.id).status).toBe("configured");
    });
  }

  it("refuses an ownership directory redirected outside the repository", async () => {
    const f = fixture(), outside = fixture();
    fs.mkdirSync(path.join(f.root, ".duo-project/runtime"));
    fs.symlinkSync(outside.root, path.join(f.root, ".duo-project/runtime/agent-integration"), "junction");
    for (const adapter of adapters) {
      const plan = planAgentIntegration(f.root, adapter.id, { host: f.host });
      expect(plan.applicable).toBe(false);
      expect(plan.conflicts.some((c) => c.reason.includes("symlink"))).toBe(true);
      expect((await applyAgentIntegration(f.root, plan)).value).toBeUndefined();
      expect(fs.existsSync(path.join(outside.root, `${adapter.id}.json`))).toBe(false);
    }
  });
});
