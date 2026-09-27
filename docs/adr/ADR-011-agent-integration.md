# ADR-011: Codex / Claude Code 연동

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 결정

`AgentAdapter` interface: `detect()`, `plan()`(변경 목록, dry-run 출력용), `apply()`, `uninstall()`.

| Agent | MCP 설정 대상(검증 필요) | Instruction 파일 |
|---|---|---|
| Codex | 사용자 Codex 설정의 MCP 서버 항목(`~/.codex/config.toml`의 `mcp_servers` 또는 `codex mcp add` 명령) | 프로젝트 `AGENTS.md` |
| Claude Code | 프로젝트 `.mcp.json` 또는 `claude mcp add --scope project` | 프로젝트 `CLAUDE.md` |

**검증 필요**: 위 설정 위치와 형식은 T14 착수 시 각 Agent의 최신 공식 문서로 확인하고 이 ADR을 갱신한다. 가능하면 Agent가 제공하는 CLI 명령(`mcp add`)을 우선 사용해 설정 형식 변화에 덜 의존한다.

Instruction 블록(10줄 이하, Repository Context 없음):

~~~markdown
<!-- duo:begin -->
## DUO
This repo uses DUO for project direction.
- Before starting a task, call `duo_get_context` with the task description.
- Before reporting completion, call `duo_review_changes` and report the verdict.
- Do not edit files under `.duo/`. Use `duo_propose_decision` to propose changes.
- If the verdict is ASK or BLOCK, stop and show it to the user.
<!-- duo:end -->
~~~

## 결과

- 설치는 idempotent, 백업, `--dry-run`, `--uninstall`을 지원한다([10-security.md](../10-security.md)).
- 새 Agent 추가는 Adapter 하나 추가로 끝나야 한다.
