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

- MCP 서버의 역할은 **Context Gateway**다. Agent는 `.duo-project`를 직접 읽지 않고 이 서버로 필요한 정보만 얻는다(H-10).

```text
Codex / Claude → duo_get_context(task) → Project Graph traversal → Context Compiler → Token Budget → minimal context
```

- MCP TypeScript SDK v2의 서버 패키지(`@modelcontextprotocol/server`)와 stdio transport를 쓴다. v1 통합 패키지(`@modelcontextprotocol/sdk`)는 legacy다. 이 내용은 T00 1차 조사 기준이며, **TASK-016 착수 직전에 공식 문서로 다시 확인하고 정확한 버전을 이 ADR에 기록한다**(AC-016-01).
- Tool은 9개로 고정한다([06-mcp-interface.md](../06-mcp-interface.md)). Human Action인 Decision confirm/reject는 MCP로 노출하지 않는다.
- HTTP transport는 제공하지 않는다.
- stdout은 JSON-RPC 전용이다(REQ-NFR-007).
- Tool 정의(이름, zod 스키마, handler)는 SDK와 분리된 순수 객체로 만든다. SDK API가 바뀌어도 어댑터만 고치면 된다.

## 구현 기록 (TASK-016, 2026-09-28, AC-016-01)

- 착수 시 npm registry와 SDK 문서로 v2 stable line을 확인했다: `@modelcontextprotocol/server` latest `2.1.0`, `@modelcontextprotocol/client` latest `2.1.0`. 둘 다 exact version으로 고정했다(server는 integration dependency, client는 root devDependency로 e2e에서만 사용). 스키마는 `zod@4.6.5`(workspace 한 벌).
- 사용 API: `McpServer`, `registerTool(name, { inputSchema: z.strictObject, outputSchema, annotations }, (args, ctx) => ...)`, 취소는 `ctx.mcpReq.signal`, 전송은 `serveStdio(factory)`(era 협상, 연결당 인스턴스 하나).
- SDK import는 `packages/integration/src/mcp/`에서만 허용한다(lint `mcpSdk`). Tool handler는 SDK와 무관한 shared operation(`packages/integration/src/operations/`)을 부르며, 같은 operation을 CLI `--json`이 쓴다(C135).
- Tool은 인덱싱하지 않는다. stale이면 정상 결과 `index-required`다(C139, 06의 T00 초안 "실행 전 증분 인덱싱"을 대체). Root는 시작 시 Git top level로 검증하며 `.duo-project`를 위로 찾지 않는다.
