/**
 * Cross-language CLI end-to-end (T18.0, subprocess): each fixtures/languages/<name> project goes
 * through init → index → status → context → edit → index → review with the built duoctl. Every stack
 * gets L0; languages with an analyzer get L1 (TS/JS L2); a missing analyzer lowers confidence and
 * never creates WARN or BLOCK.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { duoctl } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const FIXTURES = fileURLToPath(new URL("../../fixtures/languages/", import.meta.url));
const gitEnv = {
  ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_AUTHOR_DATE: "2025-03-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid", GIT_COMMITTER_DATE: "2025-03-01T00:00:00Z",
};

function project(name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `duo-lang-${name}-`)));
  temps.push(root);
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8", windowsHide: true });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-qm", "initial import");
  const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
  const edit = (f: string, from: string, to: string) => {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    if (!text.includes(from)) throw new Error(`${f} lacks ${from}`);
    write(f, text.replace(from, to));
  };
  return { root, git, write, edit };
}

const spec = (id: string, title: string, implementsBlock: string, body: string) =>
  `# Spec\n\n## ${id} ${title}\n\n\`\`\`duo\nstatus: in_progress\nmilestone: M1\npriority: must\nimplements:\n${implementsBlock}\n\`\`\`\n\n${body}\n`;

interface Case {
  readonly name: string;
  readonly framework?: string;
  readonly req: string;
  readonly specText: string;
  /** language → level in status. */
  readonly levels: Readonly<Record<string, string>>;
  /** Refs the Context Packet's code/tests must contain. */
  readonly contextRefs: readonly string[];
  readonly contextLimits: readonly string[];
  readonly edit: readonly [string, string, string];
  readonly reviewLimits: readonly string[];
  /** Paths the scanner must leave out as build output. */
  readonly buildOutput?: readonly string[];
}

const CASES: readonly Case[] = [
  {
    name: "typescript", req: "TAL-01", specText: spec("TAL-01", "Vote tally", "  symbols: [tally]", "Votes are counted case-insensitively."),
    levels: { typescript: "L2" }, contextRefs: ["src/tally.ts#tally", "src/normalize.ts#normalize"], contextLimits: [],
    edit: ["src/normalize.ts", "toLowerCase()", "toLocaleLowerCase()"], reviewLimits: [],
  },
  {
    name: "java-spring", framework: "spring-boot", req: "ORD-01",
    specText: spec("ORD-01", "Place orders", "  symbols: [OrderService.place]", "An order with an empty quantity is rejected."),
    levels: { java: "L1" }, contextRefs: ["src/main/java/com/example/orders/OrderService.java#OrderService.place"], contextLimits: ["imports-syntactic", "calls-unresolved"],
    edit: ["src/main/java/com/example/orders/OrderService.java", "quantity <= 0", "quantity < 1"], reviewLimits: ["imports-syntactic", "calls-unresolved"],
    buildOutput: ["target/classes/application.properties"],
  },
  {
    name: "csharp-unity", framework: "unity", req: "ARN-01",
    specText: spec("ARN-01", "Player health", "  symbols: [Arena.PlayerHealth.TakeDamage]", "Health never drops below zero."),
    levels: { csharp: "L1" }, contextRefs: ["Assets/Scripts/PlayerHealth.cs#Arena.PlayerHealth.TakeDamage"], contextLimits: ["imports-syntactic", "calls-unresolved"],
    edit: ["Assets/Scripts/PlayerHealth.cs", "value < 0 ? 0 : value", "value <= 0 ? 0 : value"], reviewLimits: ["imports-syntactic", "calls-unresolved"],
    buildOutput: ["Library/LastSceneManagerSetup.txt"],
  },
  {
    name: "cpp-unreal", framework: "unreal", req: "SHT-01",
    specText: spec("SHT-01", "Weapon fire", "  paths: [Source/Shooter/Private/Weapon.cpp]", "A weapon never fires more rounds than it holds."),
    levels: { cpp: "L1", csharp: "L1" }, contextRefs: ["Source/Shooter/Private/Weapon.cpp#AWeapon.Fire", "Source/Shooter/Private/Weapon.cpp#ClampRounds"],
    contextLimits: ["imports-partial", "calls-same-file"],
    edit: ["Source/Shooter/Private/Weapon.cpp", "Ammo -= Fired;", "Ammo = Ammo - Fired;"], reviewLimits: ["imports-partial", "calls-same-file"],
    buildOutput: ["Intermediate/Build/Win64/Shooter.target.txt"],
  },
  {
    name: "python-fastapi", framework: "fastapi", req: "ACC-01",
    specText: spec("ACC-01", "Trimmed user names", "  symbols: [create_user]", "User names are stored trimmed."),
    levels: { python: "L1" }, contextRefs: ["app/users.py#create_user"], contextLimits: ["imports-partial", "calls-same-file"],
    edit: ["app/users.py", "return name.strip()", "return name.strip(\" \")"], reviewLimits: ["imports-partial", "calls-same-file"],
    buildOutput: ["app/__pycache__/users.cpython-312.pyc.txt"],
  },
];

function adopt(root: string) {
  const r = duoctl(root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([{ question: "project_goal", value: "Keep the project on course." }]));
  expect(r.code, r.stdout + r.stderr).toBe(0);
  return r.json().result;
}

describe.each(CASES.map((c) => [c.name, c] as const))("%s through the CLI (T18.0)", (_n, c) => {
  it("init observes the stack, index and status report the analysis level, context and review are capability-aware", () => {
    const p = project(c.name);
    const init = adopt(p.root);
    const observed = init.plan.observed;
    if (c.framework !== undefined) expect(observed.stack.frameworks.map((f: { framework: string }) => f.framework)).toContain(c.framework);
    for (const language of Object.keys(c.levels)) expect(observed.languages.find((l: { language: string }) => l.language === language)).toMatchObject({ analyzed: true });

    p.write(".duo-project/specs/main.md", c.specText);
    const idx = duoctl(p.root, ["index", "--json"]);
    expect(idx.code, idx.stdout).toBe(0);
    expect(idx.json().diagnostics.map((d) => d.code)).not.toContain("DECLARED_SYMBOL_UNRESOLVED");

    const status = duoctl(p.root, ["status", "--json"]).json().result;
    expect(status.index.status).toBe("current");
    for (const [language, level] of Object.entries(c.levels)) expect(status.analysis.languages.find((l: { language: string }) => l.language === language)).toMatchObject({ level });
    expect(duoctl(p.root, ["status"]).stdout).toMatch(/Analysis: .*L[12]/u);

    const scan = status.analysis.files.total as number;
    expect(scan).toBeGreaterThan(0);
    for (const out of c.buildOutput ?? []) expect(duoctl(p.root, ["trace", out, "--json"]).code).toBe(1); // not in the graph

    const ctx = duoctl(p.root, ["context", c.req, "--json"]);
    expect(ctx.code, ctx.stdout).toBe(0);
    const packet = ctx.json().result.context.packet;
    expect(ctx.json().result.status).toBe("ready");
    const refs = [...packet.code, ...packet.tests].map((i: { ref: string }) => i.ref);
    for (const ref of c.contextRefs) expect(refs).toContain(ref);
    const codes = packet.limitations.map((l: { code: string }) => l.code);
    for (const code of c.contextLimits) expect(codes).toContain(code);

    p.edit(...c.edit);
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
    const rv = duoctl(p.root, ["review", "--task", c.req, "--json"]);
    expect(rv.code, rv.stdout).toBe(0);
    const review = rv.json().result;
    expect(review).toMatchObject({ status: "ready", metrics: { llmCalls: 0 } });
    expect(review.diff.files.map((f: { path: string }) => f.path)).toContain(c.edit[0]);
    const rcodes = review.limitations.map((l: { code: string }) => l.code);
    for (const code of c.reviewLimits) expect(rcodes).toContain(code);
    expect(rcodes).not.toContain("structural-analysis-unavailable");
    expect(review.verdict).not.toBe("BLOCK");
  });
});

describe("a language DUO has no analyzer for (T18.0)", () => {
  it("L0 only: file nodes, Truth references, bounded context and file-level review, never WARN or BLOCK", () => {
    const p = project("unknown");
    const init = adopt(p.root);
    expect(init.plan.observed.stack.frameworks).toEqual([]);
    p.write(".duo-project/specs/rules.md", spec("RUL-01", "Discount rule", "  paths: [src/example.foo]", "Carts over 100 get ten percent off."));
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);

    const status = duoctl(p.root, ["status", "--json"]).json().result;
    expect(status.analysis.languages).toEqual([]);
    expect(status.analysis.fileOnly).toMatchObject({ level: "L0", extensions: expect.arrayContaining([{ extension: "foo", files: 2 }]) });

    const trace = duoctl(p.root, ["trace", "RUL-01", "--json"]).json().result;
    expect(trace.edges).toEqual(expect.arrayContaining([{ from: "file:src/example.foo", type: "IMPLEMENTS", to: "req:RUL-01" }]));

    const ctx = duoctl(p.root, ["context", "RUL-01", "--json"]).json().result;
    expect(ctx.status).toBe("ready");
    const item = ctx.context.packet.code.find((i: { ref: string }) => i.ref === "src/example.foo");
    expect(item).toBeDefined();
    expect(item.text.length).toBeLessThan(2500); // a bounded window, never an unbounded file
    expect(ctx.context.packet.limitations.map((l: { code: string }) => l.code)).toContain("structural-analysis-unavailable");

    p.edit("src/example.foo", "0.9", "0.85");
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
    const review = duoctl(p.root, ["review", "--task", "RUL-01", "--json"]).json().result;
    expect(review.status).toBe("ready");
    expect(review.limitations.map((l: { code: string }) => l.code)).toContain("structural-analysis-unavailable");
    expect(["PASS", "ASK"]).toContain(review.verdict);
    expect(review.claims.filter((c: { drift?: boolean; blockEligible?: boolean }) => c.blockEligible === true)).toEqual([]);

    const impact = duoctl(p.root, ["impact", "src/example.foo", "--json"]).json().result;
    expect(impact.limitations.map((l: { code: string }) => l.code)).toContain("structural-analysis-unavailable");
  });
});

describe("a polyglot repository (T18.0)", () => {
  it("each file gets its own analyzer; a seed's context follows the seed's language", () => {
    const p = project("polyglot");
    adopt(p.root);
    p.write(".duo-project/specs/cart.md", spec("CART-01", "Cart total", "  symbols: [cartTotal, CartService.cartTotal, cart_total]", "Every client computes the same cart total."));
    const idx = duoctl(p.root, ["index", "--json"]);
    expect(idx.code).toBe(0);
    expect(Object.keys(idx.json().result.metrics.languages)).toEqual(expect.arrayContaining(["cpp", "csharp", "java", "python", "typescript"]));

    const status = duoctl(p.root, ["status", "--json"]).json().result;
    expect(status.analysis.languages.map((l: { language: string; level: string }) => `${l.language}:${l.level}`)).toEqual(["cpp:L1", "csharp:L1", "java:L1", "python:L1", "typescript:L2"]);

    const all = duoctl(p.root, ["context", "CART-01", "--json"]).json().result.context.packet;
    const refs = all.code.map((i: { ref: string }) => i.ref);
    expect(refs).toEqual(expect.arrayContaining(["web/src/cart.ts#cartTotal", "api/src/main/java/com/example/api/CartService.java#CartService.cartTotal", "ml/recommender/rank.py#cart_total"]));

    // A Python seed: its same-file neighbour comes before any other language's code.
    const py = duoctl(p.root, ["context", "ml/recommender/rank.py", "--json"]).json().result.context.packet;
    const pyRefs = py.code.map((i: { ref: string }) => i.ref);
    expect(pyRefs[0]?.startsWith("ml/")).toBe(true);
    expect(pyRefs.filter((r: string) => r.startsWith("web/") || r.startsWith("api/"))).toEqual([]);
    const ts = duoctl(p.root, ["context", "web/src/cart.ts", "--json"]).json().result.context.packet;
    const tsRefs = ts.code.map((i: { ref: string }) => i.ref);
    expect(tsRefs).toEqual(expect.arrayContaining(["web/src/price.ts#price"]));
    expect(tsRefs.filter((r: string) => r.startsWith("ml/") || r.startsWith("api/"))).toEqual([]);
    // A Java symbol seed: its own class comes first; other languages only through the Requirement.
    const java = duoctl(p.root, ["context", "CartService.cartTotal", "--json"]).json().result.context.packet;
    const javaRefs = java.code.map((i: { ref: string }) => i.ref);
    expect(javaRefs[0]).toBe("api/src/main/java/com/example/api/CartService.java#CartService.cartTotal");
    const firstOther = javaRefs.findIndex((r: string) => !r.startsWith("api/"));
    const lastJava = javaRefs.findLastIndex((r: string) => r.startsWith("api/"));
    expect(firstOther === -1 || lastJava < firstOther, javaRefs.join(", ")).toBe(true);
    // A C++ file seed: its include and same-file call stay in native/.
    const cpp = duoctl(p.root, ["context", "native/src/checksum.cpp", "--json"]).json().result.context.packet;
    expect(cpp.code.map((i: { ref: string }) => i.ref).filter((r: string) => !r.startsWith("native/"))).toEqual([]);
  });
});
