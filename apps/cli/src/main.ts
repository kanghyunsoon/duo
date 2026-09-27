#!/usr/bin/env node
import { run } from "./cli.js";

process.exitCode = run(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});
