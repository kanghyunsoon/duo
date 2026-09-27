# ADR-001: 언어와 런타임

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 배경

조건: Cross-platform, 빠른 설치, Local-first, CLI, MCP, AST 분석, React UI, 장기적으로 단일 binary 또는 단순한 설치.

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| TypeScript + Node.js | 공식 MCP TypeScript SDK, React와 같은 언어, npm/npx 배포, tree-sitter WASM, 개발 환경에 이미 설치(Node v24.18.0) | 단일 binary는 Node SEA 등 추가 작업 필요, 대형 repo 성능은 Rust/Go보다 불리 |
| TypeScript + Bun | 빠른 시작, `bun build --compile` 단일 binary, 내장 SQLite | Windows 호환성과 생태계 성숙도 위험, 사용자 환경에 미설치 |
| Rust | 성능, 단일 binary, tree-sitter 네이티브 | UI와 언어 분리, 개발 속도, MCP SDK 성숙도 |
| Go | 단일 binary, 배포 쉬움 | tree-sitter는 cgo 필요, UI 분리 |
| Python | AST 도구 풍부 | 배포(가상환경), 성능, React 분리 |

## 결정

TypeScript(strict) + Node.js 24 LTS(`engines: ">=24.15"`). ESM only.

## 결과

- 장점: 하나의 언어로 Core/CLI/MCP/UI 개발. 설치는 `npm i -g` 또는 `npx`.
- 단점: 단일 binary는 후속 과제(ADR-010).
- 재검토 조건: benchmark에서 1만 파일 init이 NFR-04를 크게 넘고 병목이 런타임 자체일 때 인덱서만 Rust로 분리하는 방안을 검토한다.
