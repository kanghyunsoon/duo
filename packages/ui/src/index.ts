/**
 * @duo/ui — React application (type-only access to core, data via HTTP API).
 * T01 skeleton only. Domain code starts in TASK-018 (docs/tasks/TASKS.md).
 */
import type { PackageInfo } from "@duo/core";

// ui는 core의 타입만 가져온다. 런타임 데이터는 integration의 HTTP API로만 받는다(ADR-010).
export const packageInfo: PackageInfo = { name: "@duo/ui", dependsOn: [] };
