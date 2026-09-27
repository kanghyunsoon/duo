/**
 * YAML source parsing. Only this layer knows the "yaml" library; callers receive plain data
 * plus a locator, never YAML AST types.
 */
import { isMap, isNode, isScalar, LineCounter, parseDocument, visit, type Node as YamlNode } from "yaml";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult, type SourceLocation } from "../diagnostics.js";

export interface YamlInput {
  /** Repository-relative POSIX path used in diagnostics. */
  readonly path: string;
  readonly text: string;
  /** File line where text starts (for YAML embedded in Markdown). Default 1. */
  readonly startLine?: number;
}

export type DataPath = readonly (string | number)[];

export interface ParsedYaml {
  /** Plain JavaScript data. Unvalidated: pass it through a schema before using it. */
  readonly data: unknown;
  /** Location of the value at path, or of the key itself with target "key". */
  locate(path: DataPath, target?: "value" | "key"): SourceLocation | undefined;
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/**
 * Parses YAML conservatively: YAML 1.2 core schema, unique keys, no merge keys,
 * no explicit tags, no anchors or aliases. Alias expansion limits stay enabled.
 */
export function parseYaml(input: YamlInput): ParseResult<ParsedYaml> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(input.text, {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: true,
    strict: true,
    merge: false,
    schema: "core",
  });
  const lineBase = (input.startLine ?? 1) - 1;
  const at = (start: number, end?: number): SourceLocation => {
    const s = lineCounter.linePos(start);
    const location = { path: input.path, startLine: s.line + lineBase, startColumn: s.col };
    if (end === undefined || end <= start) return location;
    const e = lineCounter.linePos(end);
    return { ...location, endLine: e.line + lineBase, endColumn: e.col };
  };
  const rangeOf = (node: YamlNode): SourceLocation | undefined =>
    node.range ? at(node.range[0], node.range[1]) : undefined;

  const diagnostics: Diagnostic[] = [];
  for (const error of doc.errors) {
    diagnostics.push(createDiagnostic("YAML_SYNTAX_ERROR", `${firstLine(error.message)} (${error.code})`, at(error.pos[0], error.pos[1])));
  }
  for (const warning of doc.warnings) {
    if (warning.code === "TAG_RESOLVE_FAILED") continue; // reported as YAML_TAG_NOT_ALLOWED below
    diagnostics.push(createDiagnostic("YAML_WARNING", `${firstLine(warning.message)} (${warning.code})`, at(warning.pos[0], warning.pos[1])));
  }
  const checkNode = (node: YamlNode): void => {
    if (node.tag !== undefined) {
      diagnostics.push(createDiagnostic("YAML_TAG_NOT_ALLOWED", `Explicit YAML tag "${node.tag}" is not allowed`, rangeOf(node)));
    }
    if (node.anchor !== undefined) {
      diagnostics.push(createDiagnostic("YAML_ALIAS_NOT_ALLOWED", `YAML anchor "&${node.anchor}" is not allowed`, rangeOf(node)));
    }
  };
  visit(doc, {
    Scalar: (_key, node) => checkNode(node),
    Map: (_key, node) => checkNode(node),
    Seq: (_key, node) => checkNode(node),
    Alias: (_key, node) => {
      diagnostics.push(createDiagnostic("YAML_ALIAS_NOT_ALLOWED", `YAML alias "*${node.source}" is not allowed`, rangeOf(node)));
    },
  });
  if (diagnostics.some((d) => d.severity === "error")) return failure(diagnostics);

  let data: unknown;
  try {
    data = doc.toJS(); // default maxAliasCount stays in effect
  } catch (error) {
    return failure([...diagnostics, createDiagnostic("YAML_SYNTAX_ERROR", String(error), at(0))]);
  }

  const locate = (path: DataPath, target: "value" | "key" = "value"): SourceLocation | undefined => {
    if (target === "key" && path.length > 0) {
      const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
      const key = path[path.length - 1];
      if (!isMap(parent)) return undefined;
      const pair = parent.items.find((item) => (isScalar(item.key) ? item.key.value : item.key) === key);
      return pair && isNode(pair.key) ? rangeOf(pair.key) : undefined;
    }
    const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
    return isNode(node) ? rangeOf(node) : undefined;
  };
  return success({ data, locate }, diagnostics);
}
