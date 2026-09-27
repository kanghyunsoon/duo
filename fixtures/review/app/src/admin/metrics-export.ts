/** Exports process metrics as text lines. */
export function exportMetrics(values: Record<string, number>): string {
  return Object.entries(values).map(([k, v]) => `${k} ${v}`).join("\n");
}
