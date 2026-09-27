/** Human-readable byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Writes a size line; the writer is an injected object, so DUO cannot resolve the call. */
export function printSize(bytes: number, out: { write(line: string): void }): void {
  out.write(formatBytes(bytes) + "\n");
}
