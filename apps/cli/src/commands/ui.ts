/**
 * duoctl ui (T18.1): serves the local Project Direction Console for one repository until Ctrl+C.
 * Loopback only; --port picks the port (default: a free one); --open asks the platform to open the
 * printed URL (optional: failure is only a message). The UI reads through the shared operations and
 * writes only Decision confirm/reject. It never indexes, records a Review or touches Git.
 */
import { openInBrowser, startDuoUiServer } from "@duo-director/integration";
import { t } from "../messages.js";
import { VERSION } from "../version.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { requireProject, usage, type Env } from "./shared.js";

export interface UiOptions {
  readonly port?: string;
  readonly open: boolean;
}

export async function uiCommand(env: Env, options: UiOptions): Promise<Outcome> {
  const project = requireProject(env, "ui");
  if (project.value === undefined) return project.outcome as Outcome;
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return usage("ui", "--port must be an integer from 0 to 65535");
  let server;
  try {
    server = await startDuoUiServer({ root: env.root, port, version: VERSION, log: (line) => env.io.err(line) });
  } catch (error) {
    return failed("ui", EXIT.ERROR, [], [t(env.locale, "ui.failed", { message: (error as Error).message })]);
  }
  env.io.out(t(env.locale, "ui.ready", { url: server.launchUrl }));
  env.io.out(t(env.locale, "ui.hint"));
  if (options.open && !(await openInBrowser(server.launchUrl))) env.io.err(t(env.locale, "ui.open-failed"));
  const stop = () => { void server.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.closed;
  return { command: "ui", exitCode: EXIT.OK, result: null, diagnostics: [], human: [] };
}
