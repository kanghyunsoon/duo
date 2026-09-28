/**
 * CLI end-to-end support (T15): throwaway Git repositories that were developed without DUO, and a
 * runner for the built duoctl (apps/cli/dist/main.js) as a real subprocess. Build first (pnpm build;
 * pnpm verify does it before the tests).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_MAIN = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));

const gitEnv = {
  ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_AUTHOR_DATE: "2025-03-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid", GIT_COMMITTER_DATE: "2025-03-01T00:00:00Z",
};

export interface Project {
  readonly root: string;
  git(...args: string[]): string;
  write(file: string, text: string): void;
  read(file: string): string;
  edit(file: string, from: string, to: string): void;
}

/** A repository with months of history and no DUO: README, package.json, 32 source files, tests, a develop branch. */
export function existingProject(temps: string[]): Project {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-existing-")));
  temps.push(root);
  const p: Project = {
    root,
    git: (...args) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8", windowsHide: true }),
    write: (f, text) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); },
    read: (f) => fs.readFileSync(path.join(root, f), "utf8"),
    edit: (f, from, to) => { const t = p.read(f); if (!t.includes(from)) throw new Error(f + " lacks " + from); p.write(f, t.replace(from, to)); },
  };
  p.git("-c", "init.defaultBranch=main", "init", "-q");
  p.git("config", "core.autocrlf", "false");
  p.git("config", "commit.gpgsign", "false");
  p.git("config", "user.name", "Ada Lovelace");
  p.git("config", "user.email", "ada@duo.invalid");
  p.write("README.md", "# Orbit Tasks\n\nOrbit Tasks schedules recurring chores for small teams and reminds whoever is next.\n");
  p.write("package.json", JSON.stringify({ name: "orbit-tasks", version: "1.4.0", type: "module", scripts: { test: "vitest run", build: "tsc" } }, null, 2) + "\n");
  p.write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022" }, include: ["src"] }, null, 2) + "\n");
  p.write(".gitignore", "node_modules/\ndist/\n");
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, "0");
    const prev = String(i - 1).padStart(2, "0");
    const body = i === 1 ? "  return input + 1;" : "  return step" + prev + "(input) + " + i + ";";
    const imp = i === 1 ? "" : "import { step" + prev + " } from \"./step" + prev + ".js\";\n\n";
    p.write("src/steps/step" + n + ".ts", imp + "/** Step " + i + " of the schedule. */\nexport function step" + n + "(input: number): number {\n" + body + "\n}\n");
  }
  p.write("src/scheduler.ts", "import { step30 } from \"./steps/step30.js\";\n\nexport class Scheduler {\n  next(day: number): number {\n    return step30(day) % 7;\n  }\n}\n");
  p.write("src/reminder.ts", "import { Scheduler } from \"./scheduler.js\";\n\nexport function remind(day: number): string {\n  return \"member-\" + new Scheduler().next(day);\n}\n");
  p.write("tests/scheduler.test.ts", "import { describe, expect, it } from \"vitest\";\nimport { Scheduler } from \"../src/scheduler.js\";\n\ndescribe(\"Scheduler\", () => {\n  it(\"picks a weekday\", () => {\n    expect(new Scheduler().next(1)).toBeLessThan(7);\n  });\n});\n");
  p.git("add", "-A");
  p.git("commit", "-qm", "initial import");
  for (const i of [3, 7, 12]) {
    const n = String(i).padStart(2, "0");
    p.edit("src/steps/step" + n + ".ts", "/** Step", "/** Tuned step");
    p.git("commit", "-qam", "tune step " + n);
  }
  p.git("checkout", "-qb", "develop");
  return p;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed CLI JSON; the tests assert its shape
  json(): { format: string; ok: boolean; exitCode: number; result: any; diagnostics: { code: string }[] };
}

/** Runs the built duoctl in root (no terminal: stdin is a pipe). */
export function duoctl(root: string, args: readonly string[], input?: string): CliRun {
  if (!fs.existsSync(CLI_MAIN)) throw new Error("apps/cli/dist/main.js is missing: run pnpm build before the CLI end-to-end tests");
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], { cwd: root, input: input ?? "", encoding: "utf8", windowsHide: true, env: { ...process.env, DUO_LOCALE: "" } });
  return {
    code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr,
    json: () => JSON.parse(r.stdout) as ReturnType<CliRun["json"]>,
  };
}

/**
 * Files under root (without .git) and a hash of their bytes. SQLite's WAL sidecars of the regenerable
 * graph (graph.db-wal, graph.db-shm) are left out: a read-only connection may create them; graph.db
 * itself is compared.
 */
export function snapshot(root: string): [string, string][] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => !f.split(path.sep).includes(".git") && !/\.db-(?:wal|shm)$/u.test(f)).sort()
    .map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex") : "<dir>"]);
}
