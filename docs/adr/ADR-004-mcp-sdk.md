# ADR-004: MCP SDK와 transport

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 배경

Codex와 Claude Code는 로컬 stdio MCP 서버를 지원한다. MCP TypeScript SDK는 v2에서 기존 통합 패키지(`@modelcontextprotocol/sdk`, legacy)를 역할별 패키지(`@modelcontextprotocol/server` 등)로 나눴다.

## 결정

- `@modelcontextprotocol/server` v2와 stdio transport를 쓴다. 입력 스키마는 zod.
- HTTP transport는 v0.1에서 제공하지 않는다(로컬 전용, 공격 면 최소화).
- stdout은 JSON-RPC 전용. 모든 로그는 stderr.
- SDK 사용 코드는 `mcp` 패키지 한 곳에만 둔다.

## 결과

- v2 API에 문제가 있으면 `@modelcontextprotocol/sdk` v1로 되돌릴 수 있도록 Tool 정의(이름, zod 스키마, handler)를 SDK와 분리한 순수 객체로 만든다.
- T13 시작 시 설치할 정확한 버전을 lockfile로 고정한다.
