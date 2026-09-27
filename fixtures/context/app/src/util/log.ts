/** Structured audit log line. Never pass secrets. */
export function audit(event: string, subject: string): void {
  process.stdout.write(JSON.stringify({ event, subject, at: new Date().toISOString() }) + "\n");
}
