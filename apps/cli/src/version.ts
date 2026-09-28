/**
 * The duoctl version has one source: the package.json next to the build output (apps/cli/package.json
 * in the workspace, the published package's package.json in a packed install; both are ../package.json
 * from the module). Nothing hardcodes it.
 */
import { createRequire } from "node:module";

interface PackageJson { readonly version: string; readonly engines?: { readonly node?: string } }

const pkg = createRequire(import.meta.url)("../package.json") as PackageJson;

export const VERSION: string = pkg.version;
/** The supported Node.js range (package.json engines.node). */
export const NODE_ENGINE: string = pkg.engines?.node ?? ">=24.15.0";
