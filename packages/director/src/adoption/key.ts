/**
 * Stable violation identity (T14.1). Review claim IDs contain the diff identity, so they cannot be
 * compared with the Adoption Baseline. A violation key is rule + governing Truth entity + offending
 * entity (node ID, dependency, reference, source section): no line number, no time.
 */
import { sha256Text } from "@duo-director/core";
import type { BaselineRule } from "./types.js";

export function violationKey(rule: BaselineRule, governing: string, offending: string): string {
  return `vk-${sha256Text(`${rule}\n${governing}\n${offending}`).slice(7, 23)}`;
}

export const dependencyOffending = (manifest: string, name: string) => `dep:${manifest}#${name}`;
export const sourceOffending = (path: string, section: string | undefined) => `src:${path}#${section ?? ""}`;

/**
 * Governing entity and offending reference of a DECLARED_SYMBOL_UNRESOLVED message
 * ('<owner node ID> <field> "<name>" matches …'); undefined when it does not have that shape.
 */
export function declaredReferenceParts(message: string): { readonly governing: string; readonly offending: string } | undefined {
  const m = /^(\S+) (\S+) "(.*)" matches /u.exec(message);
  return m === null ? undefined : { governing: m[1] ?? "", offending: `ref:${m[2] ?? ""}:${m[3] ?? ""}` };
}
