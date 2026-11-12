import type { Diagnostic } from "@duo-director/core";

/** A command failure carrying diagnostics for the CLI envelope. Kept dependency-light for fast startup. */
export class CliFailure extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; "));
  }
}
