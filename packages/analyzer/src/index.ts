/**
 * @duo-director/analyzer — filesystem scan, fingerprint, LanguageAnalyzer, git.
 * T01 skeleton only. Domain code starts in TASK-004 (docs/tasks/TASKS.md).
 */
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/analyzer",
  dependsOn: [core.name],
};
