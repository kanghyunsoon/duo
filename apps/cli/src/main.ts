#!/usr/bin/env node
/** Process entry of duoctl: real terminal I/O for run(). Prompts go to stderr so stdout stays machine-readable. */
import { createInterface } from "node:readline/promises";
import { run } from "./cli.js";

let stdinText: Promise<string> | undefined;
const readStdin = () => {
  stdinText ??= new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
  return stdinText;
};

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
  async prompt(question) {
    if (process.stdin.isTTY !== true) return undefined;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  readStdin,
  cwd: () => process.cwd(),
  now: () => new Date(),
  env: process.env,
});
