/**
 * @duo/core — .duo schema, loader, decisions, verdict, shared models, tokens, fs-guard.
 * T01 skeleton only. Domain code starts in TASK-002 (docs/tasks/TASKS.md).
 */

/** Identity of a workspace package and the workspace packages it depends on at runtime. */
export interface PackageInfo {
  readonly name: string;
  readonly dependsOn: readonly string[];
}

export const packageInfo: PackageInfo = { name: "@duo/core", dependsOn: [] };
