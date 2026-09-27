/**
 * Markdown definition documents (docs/03-data-model.md "Markdown 정의 형식"):
 *   - heading (level 2–4) whose first word is an ID, immediately followed by a metadata block
 *   - YAML frontmatter with "type: decision" (ADR style: the whole file is one Decision)
 */
import { METADATA_BLOCK_LANG } from "../constants.js";
import { createDiagnostic, type Diagnostic, type ParseResult, type SourceLocation } from "../diagnostics.js";
import { ACCEPTANCE_ID_PATTERN, DEFINITION_ID_PATTERN, definitionRef } from "../ids.js";
import { DecisionSchema, IssueBlockSchema, MilestoneBlockSchema, RequirementBlockSchema } from "../schema/schemas.js";
import { validateData } from "../schema/validate.js";
import { parseMarkdown, type MarkdownDocument, type MarkdownHeading } from "../source/markdown.js";
import { parseYaml } from "../source/yaml.js";
import { MapContext, mapDecision, mapIssue, mapMilestone, mapRequirement, unknownTypeDiagnostic } from "./map.js";
import { declaredGapsOf, type GapSection } from "./gaps.js";
import { emptyDefinitionSet, type AcceptanceCriterion, type DefinitionSet } from "./model.js";

const DEFINITION_HEADING_DEPTHS = new Set([2, 3, 4]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headingId(heading: MarkdownHeading): { id: string; title: string } {
  const [id = "", ...rest] = heading.text.split(/\s+/);
  return { id, title: rest.join(" ").trim() };
}

/** Reads every definition in one Markdown document. Never throws. */
export function parseDefinitionDocument(doc: MarkdownDocument): ParseResult<DefinitionSet> {
  const out = emptyDefinitionSet();
  const diagnostics: Diagnostic[] = [];
  // An ADR-style Decision is the whole file: [start of text, end of text).
  const wholeFile: SourceLocation = doc.locationOf(0, doc.length);
  const sections: GapSection[] = [];

  if (doc.frontmatter !== undefined) {
    const parsed = parseYaml({ path: doc.path, text: doc.frontmatter.value, startLine: doc.frontmatter.contentStartLine });
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value !== undefined && isRecord(parsed.value.data) && parsed.value.data["type"] === "decision") {
      const valid = validateData(DecisionSchema, parsed.value, doc.frontmatter.location);
      diagnostics.push(...valid.diagnostics);
      if (valid.value !== undefined) {
        const decision = mapDecision(valid.value, wholeFile, new MapContext(parsed.value, doc.frontmatter.location, diagnostics));
        out.decisions.push(decision);
        sections.push({ start: 0, end: doc.length + 1, owner: definitionRef("decision", decision.id) });
      }
    }
  }

  const blocks = doc.blocks;
  const claimed = new Set<number>();
  blocks.forEach((block, index) => {
    if (block.kind !== "code" || block.lang !== METADATA_BLOCK_LANG) return;
    const heading = blocks[index - 1];
    if (heading === undefined || heading.kind !== "heading" || !DEFINITION_HEADING_DEPTHS.has(heading.depth)) {
      diagnostics.push(createDiagnostic(
        "METADATA_BLOCK_WITHOUT_HEADING",
        `A "${METADATA_BLOCK_LANG}" block must directly follow a level 2–4 heading that starts with an ID`,
        block.location,
      ));
      return;
    }
    claimed.add(index - 1);
    const { id, title } = headingId(heading);
    if (!DEFINITION_ID_PATTERN.test(id)) {
      diagnostics.push(createDiagnostic("INVALID_ID", `Heading "${heading.text}": "${id}" is not a valid ID`, heading.location));
      return;
    }
    if (title === "") {
      diagnostics.push(createDiagnostic("SCHEMA_MISSING_PROPERTY", `${id}: heading has no title after the ID`, heading.location));
      return;
    }
    const parsed = parseYaml({ path: doc.path, text: block.value, startLine: block.contentStartLine });
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value === undefined) return;
    const yaml = parsed.value;

    let sectionEnd = doc.length;
    for (let j = index + 1; j < blocks.length; j++) {
      const next = blocks[j];
      if (next?.kind === "heading" && next.depth <= heading.depth) {
        sectionEnd = next.start;
        break;
      }
    }
    const location = doc.locationOf(heading.start, sectionEnd);
    const description = doc.slice(block.end, sectionEnd).trim();
    const ctx = new MapContext(yaml, block.location, diagnostics);
    const type = isRecord(yaml.data) && "type" in yaml.data ? yaml.data["type"] : "requirement";

    if (type === "requirement") {
      const valid = validateData(RequirementBlockSchema, yaml, block.location);
      diagnostics.push(...valid.diagnostics);
      if (valid.value !== undefined) {
        out.requirements.push(mapRequirement(id, title, description, location, valid.value, ctx));
        sections.push({ start: heading.start, end: sectionEnd, owner: definitionRef("requirement", id) });
      }
    } else if (type === "issue") {
      const valid = validateData(IssueBlockSchema, yaml, block.location);
      diagnostics.push(...valid.diagnostics);
      const acceptance: AcceptanceCriterion[] = [];
      for (const item of doc.listItems) {
        if (item.start < block.end || item.start >= sectionEnd || item.leadingStrong === undefined) continue;
        if (ACCEPTANCE_ID_PATTERN.test(item.leadingStrong)) {
          acceptance.push({ id: item.leadingStrong, text: item.text, location: item.location });
        } else if (item.leadingStrong.startsWith("AC-")) {
          diagnostics.push(createDiagnostic("INVALID_ID", `"${item.leadingStrong}" is not a valid acceptance criterion ID`, item.location));
        }
      }
      if (valid.value !== undefined) {
        out.issues.push(mapIssue(id, title, description, location, valid.value, acceptance, ctx));
        sections.push({ start: heading.start, end: sectionEnd, owner: definitionRef("issue", id) });
      }
    } else if (type === "milestone") {
      const valid = validateData(MilestoneBlockSchema, yaml, block.location);
      diagnostics.push(...valid.diagnostics);
      if (valid.value !== undefined) {
        out.milestones.push(mapMilestone(id, valid.value.title, valid.value.state, valid.value.issues, location, valid.value.extensions, ctx));
        sections.push({ start: heading.start, end: sectionEnd, owner: definitionRef("milestone", id) });
      }
    } else {
      diagnostics.push(unknownTypeDiagnostic(type, yaml.locate(["type"]) ?? block.location));
    }
  });

  blocks.forEach((block, index) => {
    if (block.kind !== "heading" || claimed.has(index) || !DEFINITION_HEADING_DEPTHS.has(block.depth)) return;
    const { id } = headingId(block);
    if (DEFINITION_ID_PATTERN.test(id)) {
      diagnostics.push(createDiagnostic(
        "METADATA_BLOCK_MISSING",
        `Heading "${block.text}" starts with ID ${id} but has no "${METADATA_BLOCK_LANG}" block; it is not a definition`,
        block.location,
      ));
    }
  });

  out.gaps.push(...declaredGapsOf(doc, sections));
  return { value: out, diagnostics };
}

/** Convenience: parse Markdown text and read its definitions. */
export function parseDefinitionMarkdown(path: string, text: string): ParseResult<DefinitionSet> {
  const md = parseMarkdown(path, text);
  if (md.value === undefined) return { diagnostics: md.diagnostics };
  const defs = parseDefinitionDocument(md.value);
  return { value: defs.value ?? emptyDefinitionSet(), diagnostics: [...md.diagnostics, ...defs.diagnostics] };
}
