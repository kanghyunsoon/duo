/** Project Truth YAML files (project.yaml, constraints, decisions, proposals, milestones) and vision.md. */
import { SUPPORTED_SCHEMA_VERSIONS } from "../constants.js";
import { createDiagnostic, failure, type Diagnostic, type ParseResult, type SourceLocation } from "../diagnostics.js";
import {
  ConstraintsFileSchema, DecisionSchema, MilestoneFileSchema, ProjectConfigSchema, ProposalSchema, VisionFrontmatterSchema,
} from "../schema/schemas.js";
import { validateData } from "../schema/validate.js";
import { parseMarkdown } from "../source/markdown.js";
import { parseYaml, type ParsedYaml } from "../source/yaml.js";
import {
  MapContext, mapConstraint, mapDecision, mapMilestone, mapProjectConfig, mapProposal, mapVision,
} from "./map.js";
import type { Constraint, Decision, Milestone, ProjectConfig, Proposal, Vision } from "./model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFile(path: string, text: string): { yaml?: ParsedYaml; diagnostics: Diagnostic[]; whole: SourceLocation } {
  const parsed = parseYaml({ path, text });
  const diagnostics = [...parsed.diagnostics];
  if (parsed.value === undefined) return { diagnostics, whole: { path, startLine: 1 } };
  // Whole-file definitions use the range of the YAML document contents (start and end).
  const whole: SourceLocation = parsed.value.locate([]) ?? { path, startLine: 1 };
  return { yaml: parsed.value, diagnostics, whole };
}

export function parseProjectConfig(path: string, text: string): ParseResult<ProjectConfig> {
  const { yaml, diagnostics, whole } = parseFile(path, text);
  if (yaml === undefined) return failure(diagnostics);
  const version = isRecord(yaml.data) ? yaml.data["schema_version"] : undefined;
  if (typeof version === "number" && !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    diagnostics.push(createDiagnostic(
      "UNSUPPORTED_SCHEMA_VERSION",
      `schema_version ${version} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
      yaml.locate(["schema_version"]) ?? whole,
    ));
    return failure(diagnostics);
  }
  const valid = validateData(ProjectConfigSchema, yaml, whole);
  diagnostics.push(...valid.diagnostics);
  if (valid.value === undefined) return failure(diagnostics);
  const config = mapProjectConfig(valid.value, new MapContext(yaml, whole, diagnostics));
  return { value: config, diagnostics };
}

export function parseDecisionFile(path: string, text: string): ParseResult<Decision> {
  const { yaml, diagnostics, whole } = parseFile(path, text);
  if (yaml === undefined) return failure(diagnostics);
  const valid = validateData(DecisionSchema, yaml, whole);
  diagnostics.push(...valid.diagnostics);
  if (valid.value === undefined) return failure(diagnostics);
  return { value: mapDecision(valid.value, whole, new MapContext(yaml, whole, diagnostics)), diagnostics };
}

export function parseProposalFile(path: string, text: string): ParseResult<Proposal> {
  const { yaml, diagnostics, whole } = parseFile(path, text);
  if (yaml === undefined) return failure(diagnostics);
  const valid = validateData(ProposalSchema, yaml, whole);
  diagnostics.push(...valid.diagnostics);
  if (valid.value === undefined) return failure(diagnostics);
  return { value: mapProposal(valid.value, whole, new MapContext(yaml, whole, diagnostics)), diagnostics };
}

export function parseConstraintsFile(path: string, text: string): ParseResult<Constraint[]> {
  const { yaml, diagnostics, whole } = parseFile(path, text);
  if (yaml === undefined) return failure(diagnostics);
  const valid = validateData(ConstraintsFileSchema, yaml, whole);
  diagnostics.push(...valid.diagnostics);
  if (valid.value === undefined) return failure(diagnostics);
  const root = new MapContext(yaml, whole, diagnostics);
  const constraints = valid.value.constraints.map((c, i) => mapConstraint(c, root.child(["constraints", i])));
  return { value: constraints, diagnostics };
}

export function parseMilestoneFile(path: string, text: string): ParseResult<Milestone> {
  const { yaml, diagnostics, whole } = parseFile(path, text);
  if (yaml === undefined) return failure(diagnostics);
  const valid = validateData(MilestoneFileSchema, yaml, whole);
  diagnostics.push(...valid.diagnostics);
  if (valid.value === undefined) return failure(diagnostics);
  const d = valid.value;
  return { value: mapMilestone(d.id, d.title, d.state, d.issues, whole, d.extensions, new MapContext(yaml, whole, diagnostics)), diagnostics };
}

export function parseVisionFile(path: string, text: string): ParseResult<Vision> {
  const md = parseMarkdown(path, text);
  const diagnostics: Diagnostic[] = [...md.diagnostics];
  const doc = md.value;
  if (doc === undefined) return failure(diagnostics);
  if (doc.frontmatter === undefined) {
    diagnostics.push(createDiagnostic("SCHEMA_MISSING_PROPERTY", "vision.md needs YAML frontmatter with \"status\"", { path, startLine: 1 }));
    return failure(diagnostics);
  }
  const parsed = parseYaml({ path, text: doc.frontmatter.value, startLine: doc.frontmatter.contentStartLine });
  diagnostics.push(...parsed.diagnostics);
  if (parsed.value === undefined) return failure(diagnostics);
  const valid = validateData(VisionFrontmatterSchema, parsed.value, doc.frontmatter.location);
  diagnostics.push(...valid.diagnostics);
  if (valid.value === undefined) return failure(diagnostics);
  const body = doc.slice(doc.frontmatter.end, doc.length).trim();
  const location: SourceLocation = { path, startLine: 1, endLine: doc.lineCount };
  return { value: mapVision(valid.value, body, location, new MapContext(parsed.value, doc.frontmatter.location, diagnostics)), diagnostics };
}
