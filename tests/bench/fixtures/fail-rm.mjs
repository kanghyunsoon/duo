import fs from "node:fs";

// Preload for the #126 cleanup-failure test (node --import): the benchmark's temp directory cannot be removed, as if a
// server still held it. Every other removal goes through, and the directory stays on disk for the test to find.
const rm = fs.promises.rm;
fs.promises.rm = async (target, options) => {
  if (String(target).includes("duo-mcp-benchmark-")) {
    throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${String(target)}' (injected by fail-rm.mjs)`), { code: "EPERM" });
  }
  return rm(target, options);
};
