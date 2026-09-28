---
id: ADR-011
type: decision
title: Codex / Claude Code 연동
state: confirmed
owner: human
question: agent_integration
answer: "One AgentIntegrationAdapter per agent (codex, claude-code); project-scoped config only (Codex .codex/config.toml managed block, Claude Code .mcp.json entry); portable launch (duoctl on PATH, --root-from); short marked bridge block; plan → confirm → apply → verify"
governs:
  requirements: [REQ-AGENT-001, REQ-MCP-001]
supersedes: null
confirmed_by: human (H-36)
confirmed_at: 2026-09-28
---

# ADR-011: Codex / Claude Code 연동

상태: **Accepted** (Human 결정 H-36, TASK-017에서 공식 문서와 실제 CLI로 확인)

## 결정

Installer는 Project Direction 로직 없이 기존 CLI·MCP를 Agent의 project 설정에 연결한다. 구조는 `inspectAgentIntegration → planAgentIntegration(쓰기 0) → applyAgentIntegration → verifyAgentIntegration`이고, Agent별 차이는 `AgentIntegrationAdapter`(`plannedEntry`, `inspect`, `write`, `remove`, `readEntry`, `launchEnvironment`) 안에만 둔다. MVP 지원 Agent는 `codex`, `claude-code` 둘이다. CLI는 `duoctl install <agent>`, `install status`, `install remove <agent>`(기존 TASK-017 이름 유지).

| | Codex | Claude Code |
|---|---|---|
| 확인한 공식 문서 | Config basics·Advanced(project `.codex/config.toml`, trusted project에서만 로드, 상대 경로 규칙), Config reference(`mcp_servers.<id>.command/args/cwd/env`), MCP(서버 `instructions` 사용) | MCP(project scope `.mcp.json`, stdio 서버 환경의 `CLAUDE_PROJECT_DIR`, project 서버 approval) |
| 확인한 CLI | codex-cli 0.147.0: 임시 `CODEX_HOME`에서 project config 로드, stdio spawn 위치 probe | Claude Code 2.1.258: `claude mcp get`이 project 서버를 Pending approval로 표시(승인 전 spawn 없음) |
| MCP 설정 | project `.codex/config.toml`의 DUO 관리 블록(A안) | project `.mcp.json`의 `mcpServers["duo-director"]` |
| 항목 | `command = "duoctl"`, `args = ["mcp", "--root-from", "git-cwd", "--agent", "codex"]` | `type: stdio`, `command: duoctl`, `args: ["mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"]` |
| Bridge | `AGENTS.md` | `CLAUDE.md` |
| 사람 확인 | project trust(DUO는 바꾸지 않음) | project 서버 approval(DUO는 승인하지 않음) |

- **Codex 전략 A**(project 파일 구조적 수정)를 고른 이유: 공식 `codex mcp add`는 사용자 global ``/.codex/config.toml`에 쓴다(기본값으로 금지). TOML 전체를 재직렬화하면 사람 주석이 사라지므로, 파일 끝에 whole-line marker(`# duo-director:begin` / `# duo-director:end`)로 감싼 블록을 추가하고 블록 밖은 byte 그대로 둔다. smol-toml(1.9.0)은 기존 파일과 병합 결과를 검증하는 데만 쓴다.
- **Root**: Codex는 project stdio 서버를 세션 작업 디렉터리에서 띄우고 상대 `cwd`도 그 기준으로 푼다(하위 디렉터리 세션에서 `cwd = "."`는 하위 디렉터리였다). 절대 경로는 clone·이동에 깨지므로 `duoctl mcp --root-from git-cwd`(세션 위치의 Git top level)를 쓴다. Claude Code는 서버 환경에 `CLAUDE_PROJECT_DIR`를 넣으므로 `--root-from env:CLAUDE_PROJECT_DIR`로 duoctl이 읽는다(`${CLAUDE_PROJECT_DIR:-.}` 확장은 Claude Code 자신의 환경에서 풀려 `.`로 떨어지므로 쓰지 않음). 두 경우 모두 결과를 Git top level로 검증한다.
- **Launcher**: `DuoLauncher { kind, command, argsPrefix }`. 기본은 PATH의 `duoctl`, 선택으로 `npx --no-install duoctl`(project-local). 설정에 개발자의 소스 경로를 쓰지 않고, Agent가 찾을 수 없으면 쓰지 않는다. 상대 경로 command는 거부하고, 저장소 root의 launcher 이름 파일은 conflict. Windows에서 Codex가 `duoctl.cmd` shim을 bare command로 실행하는 것을 확인했다.
- **Bridge**: `<!-- duo-director:begin -->` … `<!-- duo-director:end -->`, 10줄 이하, 저장소 정보 없음. 서버 `instructions`에는 원칙 다섯 문장만.
- **Merge**: 기존 파일을 통째로 덮어쓰지 않는다. 같은 이름의 다른 command, 읽을 수 없는 설정, 깨진 marker, symlink는 conflict이고 `--yes`로도 덮어쓰지 않는다. 같은 설정이면 unchanged.
- **Remove**: DUO 항목과 DUO 블록만. DUO 내용만 남은 파일은 삭제. `.duo-project`는 건드리지 않는다.
- Codex plugin 패키징은 이번 범위가 아니다. Claude Code도 지원해야 하므로 portable adapter 계약을 유지하고, plugin은 이후 distribution adapter로 추가할 수 있다.

## 결과

- 설치는 idempotent이고, plan이 dry-run이며, 수정 전 백업(`.duo-project/runtime/backup/`)과 remove를 지원한다.
- 새 Agent는 adapter 하나로 추가한다. 외부 제품의 설정 변경은 adapter 안에서만 흡수한다(H-17).
- Agent 설정 파일 네 개는 core writeKind `agent-integration`으로만 쓰고, Project Graph 스캔에서 빠진다(duo-agent-integration).
