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

- 분석은 언어 비종속 인터페이스 뒤에 둔다(`packages/analyzer/src/language/types.ts`). Tree-sitter 타입은 계약에 없고 `web-tree-sitter` import는 `language/tree-sitter/`에만 있다(`scripts/boundaries.json` treeSitter, ESLint로 강제).

```ts
interface LanguageAnalyzer {
  readonly id: string;        // "typescript" | "javascript" | ...
  readonly version: string;   // 바뀌면 해당 Analyzer 파일 전체 재분석
  supports(path: RepoPath): boolean;   // 경로만 본다. 미지원 파일은 parse하지 않음
  analyze(input: { path: RepoPath; content: Uint8Array }): ParseResult<SourceAnalysis>;
  dispose(): void;            // Parser 해제
}
```

- 초기화는 비동기 factory가 한다: `createTypeScriptAnalyzer()`, `createJavaScriptAnalyzer()`, `createDefaultAnalyzerRegistry()`. web-tree-sitter runtime(`Parser.init()`)은 프로세스에 하나라 한 번만 초기화하고, Language는 Analyzer마다 grammar당 한 번 load하며, Parser는 grammar당 하나를 재사용한다. 파일마다 한 번 parse하고 tree는 추출 직후 `delete()`한다. 전역 가변 상태는 runtime 초기화 promise 하나뿐이다.
- `SourceAnalysis`(symbols, moduleReferences, callSites, annotations, parseStatus)는 [04-project-graph.md](../04-project-graph.md#sourceanalysis)에 있다. 추가 언어는 `createAnalyzerRegistry([...])`에 LanguageAnalyzer를 더하면 되고 다른 패키지를 고치지 않는다(AC-005-04).
- MVP 구현: `TypeScriptAnalyzer`(.ts .mts .cts → TypeScript grammar, .tsx → TSX grammar)와 `JavaScriptAnalyzer`(.js .mjs .cjs .jsx → JavaScript grammar). Flow, Vue, Svelte 문법은 범위 밖이다.
- T05.1: static member는 identity가 `Class.static.name`이고(instance와 구분), getter/setter는 같은 scope 안에서만 합친다. import binding, re-export, test 정의(vitest, @jest/globals, node:test explicit / test 파일 전역 heuristic)도 syntax 사실로 낸다. Analyzer version 2.
- Post-MVP: `PythonAnalyzer`(REQ-POST-003).

### 의존성과 WASM

| 패키지 | 버전(정확히 고정) | 쓰는 파일 |
|---|---|---|
| web-tree-sitter | 0.27.0 | `web-tree-sitter.wasm`(runtime) |
| tree-sitter-typescript | 0.23.2 | `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`(ABI 14) |
| tree-sitter-javascript | 0.25.0 | `tree-sitter-javascript.wasm`(ABI 15) |

- grammar WASM은 공식 패키지에 포함된 파일을 `require.resolve`로 찾는다. 저장소에 WASM을 커밋하거나 직접 만들지 않고 제3자 grammar 묶음도 쓰지 않는다. 배포 시 asset packaging은 별도 packaging 단계에서 정한다.
- grammar 패키지의 native binding 빌드 스크립트는 실행하지 않는다(`pnpm-workspace.yaml` `allowBuilds: false`). native Tree-sitter binding으로 바꾸지 않는다.
- 버전 번호만으로 호환을 가정하지 않는다. CI의 `pnpm test:grammars`가 3개 OS에서 grammar마다 `Parser.init()`, `Language.load()`, 최소 source parse를 실제로 한다(AC-005-01). ABI가 runtime 범위(`MIN_COMPATIBLE_VERSION`..`LANGUAGE_VERSION`) 밖이거나 load가 실패하면 `ANALYZER_INIT_FAILED`다.

## CALLS 한계

**CALLS extraction is syntactic. Call target resolution is not performed in TASK-005.** Analyzer는 CallSite(kind, calleeText, enclosingSymbol)만 내고 `auth.login()`을 `AuthService.login`으로 추론하지 않는다. TS/JS CALLS는 TASK-007이 정적 타입 정보 없이 **이름 기반 heuristic**으로 해석한다. 해석 순서와 놓치는 경우는 [04-project-graph.md](../04-project-graph.md#calls-해석과-한계)에 명시한다. 이 Edge의 provenance는 `static`(이름이 유일하게 해석된 경우) 또는 `heuristic`(후보가 여럿이거나 전역 이름 추정)이며, heuristic Edge만으로는 BLOCK을 낼 수 없다(ADR-007).

## 결과

- 정확도는 benchmark Coverage로 측정한다. 누락의 주원인이 CALLS라면 TS에 한해 Compiler API 보조 해석을 별도 ADR로 검토한다.
- 성능 문제가 benchmark에서 확인되기 전에는 native binding이나 증분 parse를 도입하지 않는다.
