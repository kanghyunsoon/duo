/** Loads the Project Truth Layer (.duo-project/) of a repository. Collects diagnostics; never throws for bad content. */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_FILE_NAME, STATE_DIR_NAME } from "../constants.js";
import { compareDiagnostics, createDiagnostic, type Diagnostic, type ParseResult } from "../diagnostics.js";
import { parseDefinitionMarkdown } from "../domain/definitions.js";
import {
  parseConstraintsFile, parseDecisionFile, parseMilestoneFile, parseProjectConfig, parseProposalFile, parseVisionFile,
} from "../domain/files.js";
import { emptyDefinitionSet, type DefinitionSet, type ProjectTruth, type Vision } from "../domain/model.js";
import { compareUtf8 } from "../order.js";
import { toRepoPath, type RepoPath } from "../paths.js";
import { analyzeTrace, type TraceModel, type TracePolicy } from "../trace/trace.js";

export interface LoadProjectOptions {
  readonly tracePolicy?: TracePolicy;
}

export interface LoadedProject {
  readonly truth: ProjectTruth;
  readonly trace: TraceModel;
}

interface SourceFile {
  readonly absolute: string;
  readonly path: RepoPath;
}

function listFiles(root: string, dir: string, extensions: readonly string[], diagnostics: Diagnostic[]): SourceFile[] {
  if (!fs.existsSync(dir)) return [];
  const files: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const absolute = path.join(dir, entry);
    if (!extensions.some((e) => entry.toLowerCase().endsWith(e)) || !fs.statSync(absolute).isFile()) continue;
    const repo = toRepoPath(root, absolute);
    diagnostics.push(...repo.diagnostics);
    if (repo.value !== undefined) files.push({ absolute, path: repo.value });
  }
  return files.sort((a, b) => compareUtf8(a.path, b.path));
}

function readText(file: SourceFile, diagnostics: Diagnostic[]): string | undefined {
  try {
    return fs.readFileSync(file.absolute, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    diagnostics.push(createDiagnostic("FILE_READ_ERROR", String(error), { path: file.path }));
    return undefined;
  }
}

function merge(target: ReturnType<typeof emptyDefinitionSet>, source: DefinitionSet): void {
  target.requirements.push(...source.requirements);
  target.decisions.push(...source.decisions);
  target.constraints.push(...source.constraints);
  target.issues.push(...source.issues);
  target.milestones.push(...source.milestones);
  target.proposals.push(...source.proposals);
}

/**
 * Reads .duo-project/ under root. Returns the Project Truth it could read plus every diagnostic.
 * The value is undefined only when project.yaml is missing, unreadable or unsupported.
 */
export function loadProjectTruth(root: string, options: LoadProjectOptions = {}): ParseResult<LoadedProject> {
  const diagnostics: Diagnostic[] = [];
  const stateDir = path.join(root, STATE_DIR_NAME);
  const projectFile: SourceFile = {
    absolute: path.join(stateDir, PROJECT_FILE_NAME),
    path: `${STATE_DIR_NAME}/${PROJECT_FILE_NAME}` as RepoPath,
  };
  if (!fs.existsSync(projectFile.absolute)) {
    return { diagnostics: [createDiagnostic("PROJECT_FILE_MISSING", `${projectFile.path} not found`, { path: projectFile.path })] };
  }
  const projectText = readText(projectFile, diagnostics);
  if (projectText === undefined) return { diagnostics };
  const config = parseProjectConfig(projectFile.path, projectText);
  diagnostics.push(...config.diagnostics);
  if (config.value === undefined) return { diagnostics: [...diagnostics].sort(compareDiagnostics) };

  const defs = emptyDefinitionSet();
  const files: RepoPath[] = [projectFile.path];
  const read = (file: SourceFile): string | undefined => {
    const text = readText(file, diagnostics);
    if (text !== undefined) files.push(file.path);
    return text;
  };

  let vision: Vision | undefined;
  const visionFile: SourceFile = { absolute: path.join(stateDir, "intent", "vision.md"), path: `${STATE_DIR_NAME}/intent/vision.md` as RepoPath };
  if (fs.existsSync(visionFile.absolute)) {
    const text = read(visionFile);
    if (text !== undefined) {
      const r = parseVisionFile(visionFile.path, text);
      diagnostics.push(...r.diagnostics);
      vision = r.value;
    }
  }
  const constraintsFile: SourceFile = {
    absolute: path.join(stateDir, "intent", "constraints.yaml"),
    path: `${STATE_DIR_NAME}/intent/constraints.yaml` as RepoPath,
  };
  if (fs.existsSync(constraintsFile.absolute)) {
    const text = read(constraintsFile);
    if (text !== undefined) {
      const r = parseConstraintsFile(constraintsFile.path, text);
      diagnostics.push(...r.diagnostics);
      defs.constraints.push(...(r.value ?? []));
    }
  }

  const proposalsDir = path.join(stateDir, "decisions", "proposals");
  const markdownDirs = ["specs", "decisions", "milestones"].map((d) => path.join(stateDir, d));
  for (const dir of markdownDirs) {
    for (const file of listFiles(root, dir, [".md"], diagnostics)) {
      if (file.absolute.startsWith(proposalsDir + path.sep)) continue;
      const text = read(file);
      if (text === undefined) continue;
      const r = parseDefinitionMarkdown(file.path, text);
      diagnostics.push(...r.diagnostics);
      if (r.value !== undefined) merge(defs, r.value);
    }
  }
  for (const file of listFiles(root, path.join(stateDir, "decisions"), [".yaml", ".yml"], diagnostics)) {
    const text = read(file);
    if (text === undefined) continue;
    if (file.absolute.startsWith(proposalsDir + path.sep)) {
      const r = parseProposalFile(file.path, text);
      diagnostics.push(...r.diagnostics);
      if (r.value !== undefined) defs.proposals.push(r.value);
    } else {
      const r = parseDecisionFile(file.path, text);
      diagnostics.push(...r.diagnostics);
      if (r.value !== undefined) defs.decisions.push(r.value);
    }
  }
  for (const file of listFiles(root, path.join(stateDir, "milestones"), [".yaml", ".yml"], diagnostics)) {
    const text = read(file);
    if (text === undefined) continue;
    const r = parseMilestoneFile(file.path, text);
    diagnostics.push(...r.diagnostics);
    if (r.value !== undefined) defs.milestones.push(r.value);
  }

  const trace = analyzeTrace({ ...defs, references: config.value.references }, options.tracePolicy);
  diagnostics.push(...trace.diagnostics);
  const truth: ProjectTruth = { ...defs, config: config.value, vision, files: files.sort(compareUtf8) };
  return { value: { truth, trace: trace.model }, diagnostics: diagnostics.sort(compareDiagnostics) };
}
