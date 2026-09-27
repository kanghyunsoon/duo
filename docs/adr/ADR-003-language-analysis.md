---
id: ADR-003
type: decision
title: 언어 분석 구조
state: confirmed
owner: human
question: language_analysis
answer: "LanguageAnalyzer interface; TypeScript/JavaScript analyzers on web-tree-sitter for MVP"
governs:
  requirements: [REQ-INDEX-001, REQ-INDEX-003, REQ-GRAPH-001]
supersedes: null
confirmed_by: human (H-2)
confirmed_at: 2026-09-27
---

# ADR-003: 언어 분석 구조

상태: **Accepted** (Human 결정 H-2)

## 결정

- 분석은 언어 비종속 인터페이스 뒤에 둔다.

```ts
interface LanguageAnalyzer {
  readonly id: string;        // "typescript" | "javascript" | ...
  readonly version: string;   // 바뀌면 해당 언어 파일 전체 재분석
  init(): Promise<void>;      // WASM grammar 로드
  supports(filePath: string): boolean;
  analyze(filePath: string, source: string): AnalysisResult;
}
```

- `AnalysisResult`는 symbols, imports, references(call), tests, diagnostics로 구성되며 정의는 [04-project-graph.md](../04-project-graph.md#analysisresult)에 있다.
- MVP 구현: `TypeScriptAnalyzer`(.ts .tsx .mts .cts)와 `JavaScriptAnalyzer`(.js .jsx .mjs .cjs). 두 Analyzer는 web-tree-sitter 기반 공통 기반 클래스를 공유하고 grammar만 다르다.
- Post-MVP: `PythonAnalyzer`(REQ-POST-003). 새 Analyzer를 추가할 때 다른 패키지를 고치지 않아야 한다(AC-005-04).
- web-tree-sitter와 grammar wasm 버전은 정확히 고정하고 wasm 파일은 패키지에 포함한다.

## CALLS 한계

TS/JS CALLS는 정적 타입 정보 없이 **이름 기반 heuristic**으로 해석한다. 해석 순서와 놓치는 경우는 [04-project-graph.md](../04-project-graph.md#calls-해석과-한계)에 명시한다. 이 Edge의 provenance는 `static`(이름이 유일하게 해석된 경우) 또는 `heuristic`(후보가 여럿이거나 전역 이름 추정)이며, heuristic Edge만으로는 BLOCK을 낼 수 없다(ADR-007).

## 결과

- 정확도는 benchmark Coverage로 측정한다. 누락의 주원인이 CALLS라면 TS에 한해 Compiler API 보조 해석을 별도 ADR로 검토한다.
- TASK-005를 시작할 때 grammar ABI 호환 테스트를 먼저 만든다. 문제가 있으면 미리 빌드된 wasm 묶음 패키지를 대안으로 쓴다.
