# ADR-003: AST 파서

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 배경

Symbol, import, call 관계를 LLM 없이 추출해야 한다. 향후 다중 언어 확장이 필요하다.

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| web-tree-sitter(WASM) + grammar wasm | 네이티브 빌드 없음, 다중 언어 동일 API, 빠름 | 타입 정보 없음(CALLS 정확도 한계), runtime과 grammar ABI 호환 관리 필요 |
| tree-sitter(Node 네이티브) | 빠름 | 네이티브 빌드 |
| TypeScript Compiler API | TS 타입 기반 정확한 호출 해석 | TS/JS 전용, 대형 프로젝트에서 메모리·시간 비용 큼 |
| Babel parser | 성숙 | JS/TS 전용, 호출 해석은 직접 구현 |

## 결정

`web-tree-sitter`와 TypeScript/TSX/JavaScript grammar wasm을 쓴다. 버전은 정확히 고정하고, grammar wasm은 패키지에 포함한다. `LanguageAdapter` interface로 언어별 구현을 분리한다. v0.1 대상 언어는 TS/JS([conflicts.md Q2](../conflicts.md)).

## 결과

- CALLS는 이름 기반 해석이다(04 문서의 한계 절). 정확도는 benchmark Coverage로 측정한다.
- T05 시작 시 grammar wasm의 ABI 호환을 확인하는 테스트를 먼저 만든다. 호환 문제가 있으면 미리 빌드된 wasm 묶음 패키지를 대안으로 쓴다.
- 재검토 조건: Coverage 누락의 주원인이 CALLS 해석이면 TS 한정으로 Compiler API 보조 해석을 추가 검토한다.
