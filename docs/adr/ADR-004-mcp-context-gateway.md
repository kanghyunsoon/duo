---
id: ADR-004
type: decision
title: MCP SDK와 Context Gateway
state: confirmed
owner: human
question: mcp_server
answer: "MCP TypeScript SDK v2 server over stdio, 9 tools, re-verify official docs before TASK-016"
governs:
  requirements: [REQ-MCP-001, REQ-NFR-007, REQ-CONTEXT-001]
supersedes: null
confirmed_by: human (H-10)
confirmed_at: 2026-09-27
---

# ADR-004: MCP SDK와 Context Gateway

상태: **Accepted** (Human 결정 H-10)

## 결정

- MCP 서버의 역할은 **Context Gateway**다. Agent는 `.duo`를 직접 읽지 않고 이 서버로 필요한 정보만 얻는다(H-10).

```text
Codex / Claude → duo_get_context(task) → Project Graph traversal → Context Compiler → Token Budget → minimal context
```

- MCP TypeScript SDK v2의 서버 패키지(`@modelcontextprotocol/server`)와 stdio transport를 쓴다. v1 통합 패키지(`@modelcontextprotocol/sdk`)는 legacy다. 이 내용은 T00 1차 조사 기준이며, **TASK-016 착수 직전에 공식 문서로 다시 확인하고 정확한 버전을 이 ADR에 기록한다**(AC-016-01).
- Tool은 9개로 고정한다([06-mcp-interface.md](../06-mcp-interface.md)). Human Action인 Decision confirm/reject는 MCP로 노출하지 않는다.
- HTTP transport는 제공하지 않는다.
- stdout은 JSON-RPC 전용이다(REQ-NFR-007).
- Tool 정의(이름, zod 스키마, handler)는 SDK와 분리된 순수 객체로 만든다. SDK API가 바뀌어도 어댑터만 고치면 된다.
