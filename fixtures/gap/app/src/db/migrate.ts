export interface Step {
  id: number;
  sql: string;
}

/** Runs the steps above the current version, in order. */
export function migrate(steps: readonly Step[], current: number, run: (sql: string) => void): number {
  let version = current;
  for (const s of [...steps].sort((a, b) => a.id - b.id)) {
    if (s.id <= version) continue;
    run(s.sql);
    version = s.id;
  }
  return version;
}

/** A migration step that adds an index. */
export function addIndex(id: number, table: string, column: string): Step {
  return { id, sql: `CREATE INDEX idx_${table}_${column} ON ${table} (${column});` };
}
