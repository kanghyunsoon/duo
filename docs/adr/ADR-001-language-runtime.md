---
id: ADR-001
type: decision
title: 언어와 런타임
state: confirmed
owner: human
question: runtime
answer: "TypeScript (strict, ESM) on Node.js >=24.15.0 with pnpm workspace; CI baseline Node 24"
governs:
  requirements: [REQ-NFR-001, REQ-NFR-003, REQ-CLI-001]
supersedes: null
confirmed_by: human (H-12)
confirmed_at: 2026-09-27
---

# ADR-001: 언어와 런타임

상태: **Accepted** (Human 결정 H-12)

## 배경

조건은 Cross-platform, 빠른 설치, Local-first, CLI, MCP, AST 분석, React UI, 장기적인 단일 binary 지향이다(D§17).

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| TypeScript + Node.js | 공식 MCP TypeScript SDK, React와 같은 언어, npm/npx 배포, tree-sitter WASM | 단일 binary는 Node SEA 등 추가 작업이 필요하고, 대형 repo 성능은 Rust/Go보다 불리 |
| TypeScript + Bun | 빠른 시작, 단일 binary 빌드, 내장 SQLite | Windows 호환성과 생태계 성숙도 위험 |
| Rust | 성능, 단일 binary, 네이티브 tree-sitter | UI와 언어가 갈리고 개발 속도가 느림 |
| Go | 단일 binary | tree-sitter에 cgo 필요, UI와 언어가 갈림 |
| Python | AST 도구 풍부 | 가상환경 배포, 성능, UI와 언어가 갈림 |

## 결정

- TypeScript(strict), **ESM only**(`"type": "module"`, `module: NodeNext`).
- Node.js 24 계열. 최소 버전은 `node:sqlite`가 Release Candidate가 된 시점을 고려한 `>=24.15.0`이다. 특정 최신 patch에 고정하지 않는다.
- CI 기준 런타임은 Node 24(각 실행 시점의 최신 24.x).
- 개발은 **pnpm workspace**에서 한다.

## 결과

- ADR-004(MCP TS SDK), ADR-009(React), ADR-010(패키지 구조)이 이 결정을 전제로 한다.
- 재검토 조건: benchmark에서 1만 파일 init이 REQ-NFR-004를 크게 넘고 병목이 런타임 자체라면 analyzer만 다른 언어로 분리하는 방안을 검토한다.
