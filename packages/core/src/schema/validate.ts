import type { z } from "zod";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult, type SourceLocation } from "../diagnostics.js";
import type { DataPath, ParsedYaml } from "../source/yaml.js";
import { INVALID_ID_MESSAGE } from "./schemas.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(data: unknown, path: DataPath): unknown {
  let current = data;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isRecord(current) && typeof key === "string") current = current[key];
    else return undefined;
  }
  return current;
}

function describe(path: DataPath): string {
  if (path.length === 0) return "(root)";
  return path.map((k, i) => (typeof k === "number" ? `[${k}]` : i === 0 ? k : `.${k}`)).join("");
}

/**
 * Validates parsed YAML data against a strict schema and converts every Zod issue into a
 * diagnostic located at the offending YAML key or value.
 */
export function validateData<S extends z.ZodType>(schema: S, yaml: ParsedYaml, fallback: SourceLocation): ParseResult<z.output<S>> {
  const result = schema.safeParse(yaml.data);
  if (result.success) return success(result.data);
  const diagnostics: Diagnostic[] = [];
  const where = (path: DataPath, target: "value" | "key" = "value") => yaml.locate(path, target) ?? fallback;
  for (const issue of result.error.issues) {
    const path = issue.path.filter((k): k is string | number => typeof k === "string" || typeof k === "number");
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        diagnostics.push(createDiagnostic(
          "SCHEMA_UNKNOWN_PROPERTY",
          `Unknown property "${describe([...path, key])}". Put custom data under "extensions".`,
          where([...path, key], "key"),
        ));
      }
      continue;
    }
    const value = valueAt(yaml.data, path);
    const parent = valueAt(yaml.data, path.slice(0, -1));
    const last = path[path.length - 1];
    if (issue.code === "invalid_type" && value === undefined && typeof last === "string" && isRecord(parent) && !(last in parent)) {
      diagnostics.push(createDiagnostic("SCHEMA_MISSING_PROPERTY", `Missing required property "${describe(path)}"`, where(path.slice(0, -1))));
    } else if (issue.message === INVALID_ID_MESSAGE) {
      diagnostics.push(createDiagnostic("INVALID_ID", `${describe(path)}: "${String(value)}" is not a valid ID`, where(path)));
    } else if (path.length === 0 && !isRecord(yaml.data)) {
      diagnostics.push(createDiagnostic("SCHEMA_INVALID_VALUE", "Expected a mapping of properties", where(path)));
    } else {
      diagnostics.push(createDiagnostic("SCHEMA_INVALID_VALUE", `${describe(path)}: ${issue.message}`, where(path)));
    }
  }
  return failure(diagnostics);
}
