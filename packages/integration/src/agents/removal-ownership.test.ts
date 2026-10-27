import { execFileSync } from "node:child_process";
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

describe("file ownership across install and remove (#104, H-94)", () => {
  for (const adapter of adapters) {
    const emptyConfig = adapter.id === "codex" ? "" : '{\n  "mcpServers": {}\n}\n';
    const record = `.duo-project/runtime/agent-integration/${adapter.id}.json`;

    it(`${adapter.id}: preserves an existing empty config and bridge (tracked or untracked, LF or CRLF) through repeated install, update and remove`, async () => {
      for (const tracked of [false, true]) {
        const f = fixture();
        const cfg = adapter.id === "codex" ? "" : "{\r\n  \"mcpServers\": {}\r\n}";
        f.write(adapter.mcpTarget, cfg);
        f.write(adapter.bridgeTarget, "");
        if (tracked) {
          execFileSync("git", ["init", "-q"], { cwd: f.root });
          execFileSync("git", ["config", "user.name", "Test"], { cwd: f.root });
          execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: f.root });
          execFileSync("git", ["add", adapter.mcpTarget, adapter.bridgeTarget], { cwd: f.root });
          execFileSync("git", ["commit", "-qm", "empty user files"], { cwd: f.root });
        }
        const install = () => planAgentIntegration(f.root, adapter.id, { host: f.host });
        expect((await applyAgentIntegration(f.root, install())).diagnostics).toEqual([]);
        expect(install().noop).toBe(true);
        expect((await applyAgentIntegration(f.root, install())).value?.changed).toEqual([]);
        // Updating the bridge must not reclassify an existing file as DUO-created (H-94 (11)).
        f.write(adapter.bridgeTarget, f.read(adapter.bridgeTarget).replace("Before substantial work", "Before old work"));
        expect((await applyAgentIntegration(f.root, install())).diagnostics).toEqual([]);

        const stored = JSON.parse(f.read(record)) as { targets: Record<string, { existedBefore: boolean; preSha256: string | null; postSha256: string }> };
        expect(stored.targets[adapter.mcpTarget]?.existedBefore).toBe(true);
        expect(stored.targets[adapter.bridgeTarget]?.existedBefore).toBe(true);

        const removal = planAgentRemoval(f.root, adapter.id);
        expect(removal.willDelete).toEqual([]);
        expect(removal.willModify).toEqual([adapter.mcpTarget, adapter.bridgeTarget]);
        expect(removal.warnings.join(" ")).toContain(`keep ${adapter.mcpTarget} (it existed before DUO)`);
        expect(removal.warnings.join(" ")).toContain(`keep ${adapter.bridgeTarget} (it existed before DUO)`);
        expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
        expect(f.read(adapter.mcpTarget)).toBe(cfg);
        expect(f.read(adapter.bridgeTarget)).toBe("");
        expect(inspectAgentIntegration(f.root, adapter.id).status).toBe("not-configured");
        expect(planAgentRemoval(f.root, adapter.id).noop).toBe(true);
        expect(fs.existsSync(path.join(f.root, record))).toBe(false);
      }
    });

    it(`${adapter.id}: deletes files DUO created when their digest still matches postSha256, even after a bridge update`, async () => {
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

    it(`${adapter.id}: never deletes a DUO-created file when its current bytes no longer match postSha256 (H-94 (3))`, async () => {
      const f = fixture();
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      // Change trailing whitespace on the bridge file so postSha256 differs while content after removing DUO's block is still empty.
      f.write(adapter.bridgeTarget, f.read(adapter.bridgeTarget) + "\n");
      const removal = planAgentRemoval(f.root, adapter.id);
      expect(removal.willDelete).toEqual([adapter.mcpTarget]);
      expect(removal.willModify).toEqual([adapter.bridgeTarget]);
      expect(removal.warnings.join(" ")).toContain(`keep ${adapter.bridgeTarget} (modified since DUO installed it)`);
      expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
      expect(fs.existsSync(path.join(f.root, adapter.mcpTarget))).toBe(false);
      expect(f.read(adapter.bridgeTarget)).toBe("\n");
    });

    it(`${adapter.id}: preserves existing files and deletes missing ones independently (mixed ownership, H-94 (4))`, async () => {
      for (const existing of [adapter.mcpTarget, adapter.bridgeTarget]) {
        const f = fixture();
        f.write(existing, existing === adapter.mcpTarget ? emptyConfig : "");
        expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
        const removal = planAgentRemoval(f.root, adapter.id);
        expect(removal.willDelete).toEqual([existing === adapter.mcpTarget ? adapter.bridgeTarget : adapter.mcpTarget]);
        expect(removal.willModify).toEqual([existing]);
        expect((await applyAgentIntegration(f.root, removal)).diagnostics).toEqual([]);
        expect(f.read(existing)).toBe(existing === adapter.mcpTarget ? emptyConfig : "");
      }
    });

    it(`${adapter.id}: an older install or another clone without ownership evidence keeps empty files and warns (H-94 (5), (10))`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, adapter.write(undefined, adapter.plannedEntry(PATH_LAUNCHER)) as string);
      f.write(adapter.bridgeTarget, upsertBlock(undefined, bridgeLines("duoctl"), BRIDGE_MARKERS));
      const plan = planAgentRemoval(f.root, adapter.id);
      expect(plan.willDelete).toEqual([]);
      expect(plan.willModify).toEqual([adapter.mcpTarget, adapter.bridgeTarget]);
      expect(plan.warnings.join(" ")).toContain("no install record");
      expect((await applyAgentIntegration(f.root, plan)).diagnostics).toEqual([]);
      expect(f.read(adapter.mcpTarget)).toBe(emptyConfig);
      expect(f.read(adapter.bridgeTarget)).toBe("");
      expect(planAgentRemoval(f.root, adapter.id).noop).toBe(true);
    });

    it(`${adapter.id}: retains human additions to files originally created by DUO and never overwrites them with a backup (H-94 (9))`, async () => {
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

    it(`${adapter.id}: invalid or corrupted ownership records never authorize deletion, but still remove identifiable DUO content and keep the files with a warning (H-94 (5)-(7))`, async () => {
      for (const bad of [
        "{broken",
        "null",
        JSON.stringify({ format: "duo.agent-file-ownership/1", created: ["../user-file"] }),
        JSON.stringify({ format: "duo.agent-file-ownership/2", created: [] }),
        JSON.stringify({ format: "duo.agent-file-ownership/1", agent: adapter.id, created: [adapter.mcpTarget], targets: {}, digest: "0".repeat(64) }),
      ]) {
        const f = fixture();
        expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
        f.write(record, bad);
        const removal = planAgentRemoval(f.root, adapter.id);
        expect(removal.applicable).toBe(true);
        expect(removal.willDelete).toEqual([]);
        expect(removal.willModify).toEqual([adapter.mcpTarget, adapter.bridgeTarget]);
        expect(removal.warnings.join(" ")).toMatch(/invalid (?:file ownership|install) record/u);
        const applied = await applyAgentIntegration(f.root, removal);
        expect(applied.diagnostics).toEqual([]);
        expect(f.read(adapter.mcpTarget)).toBe(emptyConfig);
        expect(f.read(adapter.bridgeTarget)).toBe("");
        expect(fs.existsSync(path.join(f.root, record))).toBe(false);
      }
    });

    it(`${adapter.id}: when DUO's managed area cannot be identified safely, removal reports a conflict and changes nothing (H-94 (7))`, async () => {
      const f = fixture();
      expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }))).diagnostics).toEqual([]);
      f.write(record, "{broken");
      f.write(adapter.bridgeTarget, "<!-- duo-director:begin -->\nunclosed");
      const before = [f.read(adapter.mcpTarget), f.read(adapter.bridgeTarget)];
      const removal = planAgentRemoval(f.root, adapter.id);
      expect(removal.applicable).toBe(false);
      expect(removal.blockers.map((d) => d.code)).toEqual(["AGENT_INTEGRATION_CONFLICT"]);
      expect((await applyAgentIntegration(f.root, removal)).value).toBeUndefined();
      expect([f.read(adapter.mcpTarget), f.read(adapter.bridgeTarget)]).toEqual(before);
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

    it(`${adapter.id}: never overwrites the original backup when the user changed the file, even at the same clock timestamp`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, emptyConfig);
      f.write(adapter.bridgeTarget, "Original notes\n");
      const clock = () => new Date("2026-10-26T07:00:00.000Z");
      const first = await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }), { clock });
      expect(first.diagnostics).toEqual([]);
      const firstBackups = first.value?.backups ?? [];
      expect(firstBackups).toHaveLength(2);

      f.write(adapter.bridgeTarget, "User edited notes\n\n" + upsertBlock(undefined, bridgeLines("duoctl").slice(0, -2).concat(BRIDGE_MARKERS.end), BRIDGE_MARKERS));
      const second = await applyAgentIntegration(f.root, planAgentIntegration(f.root, adapter.id, { host: f.host }), { clock });
      expect(second.diagnostics).toEqual([]);
      const secondBackups = second.value?.backups ?? [];
      expect(secondBackups).toHaveLength(1);
      expect(secondBackups[0]).not.toBe(firstBackups[1]);
      expect(f.read(firstBackups[1] as string)).toBe("Original notes\n");
    });

    it(`${adapter.id}: detects a concurrent edit made during backup I/O and leaves the edited file untouched`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, emptyConfig);
      f.write(adapter.bridgeTarget, "Original notes\n");
      const plan = planAgentIntegration(f.root, adapter.id, { host: f.host });
      const rename = fsp.rename;
      let injected = false;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        const res = await rename(from, to);
        if (!injected && String(to).includes(path.join(".duo-project", "runtime", "backup"))) {
          injected = true;
          f.write(adapter.bridgeTarget, "Concurrent user edit\n");
        }
        return res;
      });
      const applied = await applyAgentIntegration(f.root, plan);
      expect(applied.diagnostics.map((d) => d.code)).toEqual(["AGENT_PLAN_STALE"]);
      expect(f.read(adapter.mcpTarget)).toBe(emptyConfig);
      expect(f.read(adapter.bridgeTarget)).toBe("Concurrent user edit\n");
      expect(fs.existsSync(path.join(f.root, record))).toBe(false);
    });

    it(`${adapter.id}: rollback does not overwrite a file modified by the user after DUO wrote it`, async () => {
      const f = fixture();
      f.write(adapter.mcpTarget, emptyConfig);
      f.write(adapter.bridgeTarget, "Original notes\n");
      const plan = planAgentIntegration(f.root, adapter.id, { host: f.host });
      const rename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === path.join(f.root, adapter.bridgeTarget)) {
          f.write(adapter.mcpTarget, emptyConfig + "\n# Concurrent user edit after MCP write\n");
          throw new Error("bridge write failure");
        }
        return rename(from, to);
      });
      const applied = await applyAgentIntegration(f.root, plan);
      expect(applied.diagnostics.map((d) => d.code)).toEqual(["FILE_WRITE_ERROR"]);
      expect(f.read(adapter.mcpTarget)).toContain("Concurrent user edit after MCP write");
      expect(f.read(adapter.bridgeTarget)).toBe("Original notes\n");
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

  it("refuses an ownership directory redirected outside the repository on install and treats it as no record on remove", async () => {
    const f = fixture(), outside = fixture();
    expect((await applyAgentIntegration(f.root, planAgentIntegration(f.root, "codex", { host: f.host }))).diagnostics).toEqual([]);
    fs.rmSync(path.join(f.root, ".duo-project/runtime/agent-integration"), { recursive: true, force: true });
    fs.symlinkSync(outside.root, path.join(f.root, ".duo-project/runtime/agent-integration"), "junction");
    for (const adapter of adapters) {
      const installPlan = planAgentIntegration(f.root, adapter.id, { host: f.host });
      if (!installPlan.noop) {
        expect(installPlan.applicable).toBe(false);
        expect(installPlan.conflicts.some((c) => c.reason.includes("symlink"))).toBe(true);
      }
      expect(fs.existsSync(path.join(outside.root, `${adapter.id}.json`))).toBe(false);
    }
    const removal = planAgentRemoval(f.root, "codex");
    expect(removal.willDelete).toEqual([]);
    expect(removal.warnings.join(" ")).toContain("symlink");
  });
});
