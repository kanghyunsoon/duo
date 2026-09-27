/**
 * Namespace constants. The final product name, npm package, executable, state directory and MCP
 * server name are still open (docs/conflicts.md Q-NAMESPACE). Change them here only.
 */
export const PRODUCT_NAME = "DUO";
export const CLI_NAME = "duo";
export const STATE_DIR_NAME = ".duo";
export const MCP_SERVER_NAME = "duo";

/** Info string of fenced metadata blocks in Markdown definitions (docs/03-data-model.md). */
export const METADATA_BLOCK_LANG = "duo";

export const PROJECT_FILE_NAME = "project.yaml";

/** Project Truth schema versions this build can read. No migration framework (T02). */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];
