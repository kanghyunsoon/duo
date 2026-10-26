# MCP benchmark

`mcp.mjs` measures the real `duoctl mcp` stdio server without an LLM. It uses the official MCP client, verifies the documented nine-tool contract, and calls every tool once per measured server.

```sh
pnpm benchmark:mcp
pnpm benchmark:mcp:smoke
pnpm test:mcp-benchmark
```

The full run uses 10 iterations and 8 concurrent servers. Override these with `--iterations N` and `--concurrency N` after invoking the script directly. JSON is written to stdout so callers can store it as an artifact. Diagnostic failures use stderr and a non-zero exit code.

Four scenarios are reported:

- `single-cold`: first server start on a fresh temporary fixture copy.
- `single-warm`: measured start after one unmeasured initialize and `tools/list` on that copy.
- `concurrent-cold`: eight first starts on independent fixture copies.
- `concurrent-warm`: eight measured starts, each on an independently primed copy.

“Warm” is a repeatable process/file-cache priming condition. The script does not claim to flush or control an operating system's global disk cache. Each source fixture is copied into the OS temporary directory; only disposable copies are changed. User configuration and the source fixture are never modified. `duo_propose_decision`, the only writing tool, therefore writes only to a disposable copy.

The output contains raw error details and p50/p95 wall-clock milliseconds for initialize, `tools/list`, and every tool call. These numbers are report-only and are not a performance gate.

Cross-platform compatibility is checked with the manually dispatched `mcp-benchmark` GitHub Actions workflow. It runs the smoke command on Windows, Ubuntu, and macOS with Node 24, but is intentionally not triggered by pushes or pull requests and is not a CI gate.
