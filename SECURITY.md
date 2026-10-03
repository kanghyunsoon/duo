# Security Policy

## Supported versions

DUO is in 0.x. Security fixes are made for the latest released 0.x version only.

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| 0.1.x | No (upgrade to 0.2.x; see docs/release/notes-0.2.0.md) |

## Reporting a vulnerability

**Do not report security vulnerabilities through public GitHub Issues, Discussions or pull requests.**

Use GitHub Private Vulnerability Reporting for this repository: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/kanghyunsoon/duo/security/advisories/new). The report stays private between you and the maintainers until an advisory is published.

Please include:

- the DUO version (`duoctl --version`), operating system and Node.js version
- what an attacker can do, and the steps or a minimal repository that shows it
- which surface is involved (CLI, MCP server, local UI, installed package)

Do not include API keys, tokens or private source code in a report. A redacted example is enough.

Confirmed issues are fixed in a new release and disclosed through a GitHub Security Advisory for this repository.

## Scope

In scope, for example:

- the local UI server (`duoctl ui`): loopback binding, Host and Origin checks, session and CSRF handling, requests that change Project Truth
- writes outside DUO's write boundary (`.duo-project/` and agent configuration files DUO manages), path traversal and symlink handling
- secrets from the repository or the environment reaching Context Packets, Review Records, caches, metrics or logs
- data sent to an LLM provider (the official OpenAI API or an explicitly configured OpenAI-compatible endpoint) when semantic assistance is enabled, beyond the documented evidence excerpts; credentials, endpoint paths or provider errors appearing in output, caches or logs
- the MCP server writing anything except its protocol on stdout, or acting outside the documented tools
- the published package: contents, the bundled runtime dependency tree (`dist/runtime-tree.json`), install-time behaviour

Out of scope:

- vulnerabilities in third-party dependencies that are already public: report them to the upstream project; DUO updates its pinned versions in a release
- attacks that need another account or process on the same computer: the local UI is a single-user loopback tool, not an authenticated multi-user web application (see [docs/10-security.md](docs/10-security.md))
- the `ui:<name>` actor label on confirmed Decisions: it records who acted, it is not authentication

## Past fixes and precautions

### 0.1.2: requests to an optional LLM provider

DUO 0.1.2 fixed secret redaction in requests to an optional LLM provider (semantic assist: `duoctl review --semantic` or the MCP option `includeSemanticAssist`). The default configuration (`llm.provider: none`) makes no provider call and was not affected.

If you used semantic assist with an LLM provider on DUO 0.1.1 or earlier, you may remove `.duo-project/cache/llm/` as a precaution. The directory is local, Git-ignored, and safe to regenerate.

## 보안 문제 신고 (요약)

보안 취약점은 공개 GitHub Issue로 신고하지 마세요. 이 저장소의 **Security → Report a vulnerability**(GitHub Private Vulnerability Reporting)를 사용합니다. API key, token, 비공개 코드는 신고에 넣지 않습니다.

DUO 0.1.1 이하에서 LLM provider와 semantic assist를 썼다면 예방 차원에서 `.duo-project/cache/llm/`을 지워도 됩니다. 로컬 디렉터리이고 Git ignored이며 다시 만들어집니다.
