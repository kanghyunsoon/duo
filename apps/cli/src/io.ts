/** Terminal access of the CLI (T15). Injectable so commands run in tests without a process. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** stdin and stdout are a terminal: prompts are allowed. */
  readonly isTTY: boolean;
  /** Asks one line; undefined when there is no terminal or input ended. */
  prompt(question: string): Promise<string | undefined>;
  /** The whole of stdin (for --answers -). */
  readStdin(): Promise<string>;
  cwd(): string;
  /** Wall clock for recorded timestamps and durations (never an identity). */
  now(): Date;
  /** Environment variables (DUO_LOCALE). */
  readonly env: Readonly<Record<string, string | undefined>>;
}
