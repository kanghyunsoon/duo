/**
 * Namespace constants (docs/conflicts.md H-20). The display name stays "DUO"; technical
 * identifiers avoid collisions with other AI coding tools. Change them here only.
 */
export const PRODUCT_NAME = "DUO";
export const CLI_NAME = "duoctl";
export const STATE_DIR_NAME = ".duo-project";
export const MCP_SERVER_NAME = "duo-director";

/** Info string of fenced metadata blocks in Markdown definitions (docs/03-data-model.md). */
export const METADATA_BLOCK_LANG = "duo";

export const PROJECT_FILE_NAME = "project.yaml";

/** Project Truth schema versions this build can read. No migration framework (T02). */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];
