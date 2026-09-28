/**
 * Project stack profile (T18.0): build systems, engines and frameworks read from manifests with ordinary
 * code. Observations only: a framework found here is evidence for the Human and for Context, never
 * Product Intent or a Constraint, and nothing is written to Project Truth from it. Detection needs a
 * manifest fact (a dependency name, an engine version file): source-code patterns are not used.
 *
 *   Spring Boot  pom.xml / build.gradle(.kts) naming spring-boot (starter, parent or plugin)
 *   Unity        ProjectSettings/ProjectVersion.txt (editor version) or Packages/manifest.json with com.unity.*
 *   Unreal       *.uproject (EngineAssociation), *.uplugin, *.Build.cs
 *   FastAPI      pyproject.toml, requirements*.txt, Pipfile, setup.py, setup.cfg naming the fastapi package
 */
import fs from "node:fs";
import path from "node:path";
import { compareUtf8, readSourceFile, type RepoPath } from "@duo-director/core";

export type StackEcosystem = "maven" | "gradle" | "dotnet" | "unity" | "cmake" | "unreal" | "python" | "npm";
export type StackFramework = "spring-boot" | "unity" | "unreal" | "fastapi";

export interface StackEvidence {
  readonly path: RepoPath;
  /** What in the file shows it (a dependency name, a field), never file content beyond that. */
  readonly detail: string;
}

export interface ProjectStackProfile {
  readonly provenance: "observed";
  /** Build systems / package ecosystems with their manifests (sorted, capped). */
  readonly ecosystems: readonly { readonly ecosystem: StackEcosystem; readonly manifests: readonly RepoPath[] }[];
  readonly frameworks: readonly { readonly framework: StackFramework; readonly version?: string; readonly evidence: readonly StackEvidence[] }[];
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DEPTH = 4;
const CAP = 20;

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** The ecosystem a manifest belongs to, or undefined. */
export function stackManifestKind(p: string): StackEcosystem | undefined {
  const name = baseName(p);
  if (name === "pom.xml") return "maven";
  if (/^(?:build|settings)\.gradle(?:\.kts)?$/u.test(name)) return "gradle";
  if (/\.(?:sln|csproj)$/u.test(name)) return "dotnet";
  if (p === "ProjectSettings/ProjectVersion.txt" || p === "Packages/manifest.json" || p.endsWith("/ProjectSettings/ProjectVersion.txt") || p.endsWith("/Packages/manifest.json")) return "unity";
  if (name === "CMakeLists.txt") return "cmake";
  if (/\.(?:uproject|uplugin)$/u.test(name) || /\.(?:Build|Target)\.cs$/u.test(name)) return "unreal";
  if (/^(?:pyproject\.toml|setup\.py|setup\.cfg|Pipfile|Pipfile\.lock|poetry\.lock|uv\.lock)$/u.test(name) || /^requirements[\w.-]*\.txt$/u.test(name)) return "python";
  if (name === "package.json") return "npm";
  return undefined;
}

function read(root: string, file: RepoPath): string | undefined {
  try {
    if (fs.statSync(path.join(root, file)).size > MAX_MANIFEST_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return readSourceFile(root, file).value;
}

const FASTAPI = /(?:^|[^\w.-])fastapi(?:$|[^\w-])/imu;
const SPRING_BOOT = /spring-boot-starter|spring-boot-dependencies|org\.springframework\.boot/u;

export function observeStack(root: string, files: readonly RepoPath[]): ProjectStackProfile {
  const manifests = files.filter((p) => p.split("/").length <= MAX_DEPTH).flatMap((p) => {
    const kind = stackManifestKind(p);
    return kind === undefined ? [] : [{ path: p, kind }];
  });
  const byEcosystem = new Map<StackEcosystem, RepoPath[]>();
  for (const m of manifests) byEcosystem.set(m.kind, [...(byEcosystem.get(m.kind) ?? []), m.path]);
  const ecosystems = [...byEcosystem].sort(([a], [b]) => compareUtf8(a, b))
    .map(([ecosystem, list]) => ({ ecosystem, manifests: [...list].sort(compareUtf8).slice(0, CAP) }));

  const found = new Map<StackFramework, { version?: string; evidence: StackEvidence[] }>();
  const add = (framework: StackFramework, evidence: StackEvidence, version?: string) => {
    const f = found.get(framework) ?? { evidence: [] };
    if (f.evidence.length < CAP) f.evidence.push(evidence);
    if (version !== undefined && f.version === undefined) f.version = version;
    found.set(framework, f);
  };
  for (const m of manifests) {
    const name = baseName(m.path);
    if (m.kind === "maven" || (m.kind === "gradle" && name.startsWith("build."))) {
      const text = read(root, m.path);
      const hit = text === undefined ? undefined : SPRING_BOOT.exec(text)?.[0];
      if (hit !== undefined) add("spring-boot", { path: m.path, detail: hit });
    } else if (m.kind === "unity") {
      const text = read(root, m.path);
      if (text === undefined) continue;
      if (name === "ProjectVersion.txt") {
        const version = /^m_EditorVersion:\s*(\S+)/mu.exec(text)?.[1];
        add("unity", { path: m.path, detail: "m_EditorVersion" }, version);
      } else if (/"com\.unity\.[\w.-]+"/u.test(text)) {
        add("unity", { path: m.path, detail: "com.unity packages" });
      }
    } else if (m.kind === "unreal") {
      if (name.endsWith(".uproject")) {
        const text = read(root, m.path);
        let version: string | undefined;
        try {
          const v = (JSON.parse(text ?? "") as { EngineAssociation?: unknown }).EngineAssociation;
          version = typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
        } catch {
          version = undefined;
        }
        add("unreal", { path: m.path, detail: version === undefined ? "uproject" : "EngineAssociation" }, version);
      } else {
        add("unreal", { path: m.path, detail: name.endsWith(".uplugin") ? "uplugin" : "module rules" });
      }
    } else if (m.kind === "python" && !name.endsWith(".lock")) {
      const text = read(root, m.path);
      if (text !== undefined && FASTAPI.test(text)) add("fastapi", { path: m.path, detail: "fastapi dependency" });
    }
  }
  const frameworks = [...found].sort(([a], [b]) => compareUtf8(a, b)).map(([framework, f]) => ({
    framework, ...(f.version === undefined ? {} : { version: f.version }), evidence: [...f.evidence].sort((a, b) => compareUtf8(a.path, b.path)),
  }));
  return { provenance: "observed", ecosystems, frameworks };
}

