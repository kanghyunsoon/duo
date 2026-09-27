---
id: ADR-011
type: decision
title: Codex / Claude Code 연동
state: proposed
owner: human
question: agent_integration
answer: "AgentAdapter per agent; prefer agent CLI mcp add; short marked instruction block"
governs:
  requirements: [REQ-AGENT-001, REQ-MCP-001]
supersedes: null
proposed_by: codex (TASK-000)
proposed_at: 2026-09-27
---

# ADR-011: Codex / Claude Code 연동

상태: **Proposed** (Human 검토 대기)

## 결정(제안)

`AgentAdapter` 인터페이스는 `detect()`, `plan()`(dry-run 출력), `apply()`, `uninstall()`로 구성한다.

| Agent | MCP 설정(**검증 필요**) | Instruction 파일 |
|---|---|---|
| Codex | Codex의 MCP 서버 설정(`~/.codex/config.toml`의 `mcp_servers` 항목 또는 `codex mcp add`) | 프로젝트 `AGENTS.md` |
| Claude Code | 프로젝트 `.mcp.json` 또는 `claude mcp add --scope project` | 프로젝트 `CLAUDE.md` |

위 설정 위치와 형식은 T00 1차 조사에서 공식 문서로 확인하지 못했다. **TASK-017 착수 시 각 Agent의 최신 공식 문서로 확인하고 이 ADR을 갱신한다**(AC-017-01). 설정 형식 변화에 덜 의존하도록 Agent가 제공하는 `mcp add` 계열 명령을 우선 사용한다.

Instruction 블록은 10줄 이하이며 Repository Context를 담지 않는다.

```markdown
<!-- duo-director:begin -->
## DUO
This repo uses DUO for project direction. Do not read or edit files under .duo-project/ directly.
- Before a task: call duo_get_context with the task description.
- Before reporting completion: call duo_review_changes and report the verdict.
- To change a decision: call duo_propose_decision. Never run duoctl decision confirm/reject.
- If the verdict is ASK or BLOCK, stop and show it to the user.
<!-- duo-director:end -->
```

## 결과

- 설치는 idempotent이고, 백업, `--dry-run`, `--uninstall`을 지원한다.
- 새 Agent를 추가할 때는 Adapter 하나만 추가하면 된다.
- MCP Core(TASK-016)는 ADR-004의 v2 기준으로 진행하며 Adapter 설정에 의존하지 않는다. 외부 제품의 설정 변경은 Adapter 안에서만 흡수한다(H-17).
