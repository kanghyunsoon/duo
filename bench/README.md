# MCP benchmark

`mcp.mjs` measures the real `duoctl mcp` stdio server without an LLM. It uses the official MCP client, verifies the documented nine-tool contract, and calls every tool once per measured server.

```sh
pnpm benchmark:mcp
pnpm benchmark:mcp:smoke
pnpm test:mcp-benchmark
```

The full run uses 10 iterations and 8 concurrent servers. Override these with `--iterations N` and `--concurrency N` after invoking the script directly. Initialization, `tools/list`, and each tool call have a 30-second deadline; use `--timeout-ms N` to change it. Timeouts identify their stage in the JSON error list, close the server transport (and make sure the server process is gone), and produce a non-zero exit code. JSON is written to stdout so callers can store it as an artifact. `--scenario NAME` runs only one of the four scenarios; the timeout regression test (`tests/mcp-benchmark-timeout.test.ts`) uses `--scenario single-cold`.

Exit codes: `0` every stage answered; `1` the JSON report lists stage errors (timeouts, tool or client errors); `2` the benchmark itself failed, such as an invalid argument, a setup error, or temporary fixture copies that could not be removed (usually because a server process is still running). With exit code 2, stdout is empty and the reason is on stderr.

Four scenarios are reported:

- `single-cold`: first server start on a fresh temporary fixture copy.
- `single-warm`: measured start after one unmeasured initialize and `tools/list` on that copy.
- `concurrent-cold`: eight first starts on independent fixture copies.
- `concurrent-warm`: eight measured starts, each on an independently primed copy.

“Warm” is a repeatable process/file-cache priming condition. The script does not claim to flush or control an operating system's global disk cache. Each source fixture is copied into the OS temporary directory; only disposable copies are changed. User configuration and the source fixture are never modified. `duo_propose_decision`, the only writing tool, therefore writes only to a disposable copy.

The output contains raw error details and p50/p95 wall-clock milliseconds for initialize, `tools/list`, and every tool call. These numbers are report-only and are not a performance gate.

Cross-platform compatibility is checked with the manually dispatched `mcp-benchmark` GitHub Actions workflow. It runs the smoke command on Windows, Ubuntu, and macOS with Node 24, but is intentionally not triggered by pushes or pull requests and is not a CI gate.
