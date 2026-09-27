/** SQLite schema of the graph database (ADR-002). Only the node-sqlite adapter uses SQL. */
import { ENTITY_TYPES } from "@duo-director/core";
import { GRAPH_EDGE_TYPES } from "../types.js";

/** Graph DB schema version. Different from Project Truth schema_version. Bump = regenerate. */
export const GRAPH_SCHEMA_VERSION = 1;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

export const SCHEMA_SQL = `
CREATE TABLE graph_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN (${list(ENTITY_TYPES)})),
  source_path TEXT,
  source_start_line INTEGER,
  source_start_column INTEGER,
  source_end_line INTEGER,
  source_end_column INTEGER,
  content_hash TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- listNodes({ type }) ordered by id. Lookups by id use the primary key.
CREATE INDEX graph_nodes_type ON graph_nodes (type, id);

CREATE TABLE graph_edges (
  from_id TEXT NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  type TEXT NOT NULL CHECK (type IN (${list(GRAPH_EDGE_TYPES)})),
  to_id TEXT NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  metadata TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (from_id, type, to_id)
) STRICT, WITHOUT ROWID;

-- The primary key serves edge.from and edge(from, type). This index serves edge.to and edge(to, type).
CREATE INDEX graph_edges_to ON graph_edges (to_id, type, from_id);
`;
