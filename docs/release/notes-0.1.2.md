# DUO 0.1.2 release notes (draft)

Security patch on top of 0.1.1.

## Security

- **Fixed secret redaction for optional semantic-review provider requests.** Requests to an LLM provider now apply the same credential redaction as Context Packets, at the single point where DUO calls any provider. If you ran `duoctl review --semantic` or used the MCP option `includeSemanticAssist` with an LLM provider configured in 0.1.1 or earlier, upgrade to 0.1.2.
- No change to deterministic review behavior or default LLM-disabled operation. The default configuration (`llm.provider: none`) makes no provider call and was not affected.

## Unchanged

Public formats, commands, options, exit codes, Review Records and the Truth format; the official OpenAI endpoint policy, `store: false`, DUO-owned timeouts without retries; Node.js `>=24.15.0` and the dependency tree.

