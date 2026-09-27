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
- T07: Graph Builder가 원문을 다시 읽지 않도록 `SourceAnalysis.exports`(자기 선언의 export)와 CallSite `calleePath`, `rootLocal`, `thisBinding`을 syntax 사실로 더했다. Analyzer version 3.
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

## Module resolution(TASK-007)

- Graph Builder는 `ModuleResolver` interface(`packages/graph/src/build/resolve/module-resolver.ts`)만 쓴다. 결과 모델은 resolved, external, unresolved, ambiguous, unsupported이고 TypeScript 타입을 노출하지 않는다.
- 구현 `TypeScriptModuleResolver`는 TypeScript Compiler API의 `ts.resolveModuleName`을 쓴다. DUO는 NodeNext, `.js` → `.ts` 대체, extensionless와 index, `paths`, `baseUrl`, package `exports`/`imports`를 다시 구현하지 않는다. import mode는 `getImpliedNodeFormatForFile`로 정하고 `require`는 CommonJS, dynamic import는 ESM으로 넘긴다.
- config는 source 파일에서 Repository root까지 올라가며 가장 가까운 `tsconfig.json`, 없으면 `jsconfig.json`(`allowJs`)이다. `ts.readConfigFile` + `parseJsonConfigFileContent`로 읽어 `extends`를 TypeScript가 처리하고 config별로 cache한다. 입력 파일이 없다는 오류(18003)는 무시하고 나머지 오류는 `TSCONFIG_INVALID`(warning)다. resolution cache는 config별 `ModuleResolutionCache`와 결과 cache다.
- config가 없으면 프로젝트 semantics를 아는 척하지 않는다. 상대 경로만 Bundler 규칙으로 해석하고 bare specifier는 external이다(C52).
- `node_modules`나 `isExternalLibraryImport` 결과는 external(package), Repository 밖 경로는 external(outside-repository), builtin과 `node:`는 external(builtin), URL과 절대 경로는 unsupported, Repository 안이지만 index되지 않은 파일은 unresolved(not-indexed)다. 어느 경우에도 File Node를 만들지 않는다.
- resolved 결과의 `claim`은 `typescript-resolution`이다. "TypeScript가 이 파일로 해석했다"는 뜻이며 runtime이 그 파일을 실행한다는 주장과 구분한다(`extensionSubstituted`, `declarationOnly`).
- **격리**: `typescript` import는 `packages/graph/src/build/resolve/typescript/` 안에서만 허용한다(`scripts/boundaries.json` `typescriptApi`, ESLint, `tests/workspace/boundaries.test.ts`). `typescript` 6.0.3과 `zod` 4.6.5는 graph 패키지의 runtime dependency로 정확히 고정한다.
- **TypeScript 7 위험**: TypeScript 7(native)은 Compiler API가 바뀔 수 있다. 그때는 `TypeScriptModuleResolver`만 교체한다. adapter 계약은 `typescript-module-resolver.test.ts`가 TypeScript 6 기준으로 고정하므로 upgrade 시 차이가 그 테스트에서 드러난다.
- **Type Checker 금지**: TypeScript Program 생성, type checking, symbol 해석은 쓰지 않는다. Compiler API는 module resolution에만 쓴다.

## CALLS 한계

**CALLS extraction is syntactic. Call target resolution is not performed in TASK-005.** Analyzer는 CallSite 사실만 내고 `auth.login()`을 `AuthService.login`으로 추론하지 않는다. TASK-007 Graph Builder가 syntax 사실과 module resolution만으로 해석하며 **exact 결과만** CALLS Edge(provenance `static`)로 저장한다. 같은 파일 identifier, named·aliased·default·namespace import, class member 안의 `this.m()`, class static `C.m()`만 exact가 될 수 있고, 변수 receiver(`user.load()`), 인터페이스 구현체, DI, 동적 접근, callback은 unresolved다. 이름 기반 heuristic(Repository 전체의 unique 이름 연결)은 쓰지 않는다(C48, H-24). 규칙은 [04-project-graph.md](../04-project-graph.md#calls-해석task-007)에 있다.

## 결과

- 정확도는 benchmark Coverage로 측정한다. 누락의 주원인이 CALLS라면 TS에 한해 Type Checker 기반 보조 해석을 별도 기능(필요하면 별도 ADR)으로 검토한다. resolution 비율을 높이려고 heuristic을 더하지 않는다.
- 성능 문제가 benchmark에서 확인되기 전에는 native binding이나 증분 parse를 도입하지 않는다.
