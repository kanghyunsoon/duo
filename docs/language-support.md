# 언어 지원 (T18.0 Cross-language Analysis)

DUO는 stack-agnostic하다. **모든 Git repository는 L0으로 동작하고, Analyzer가 있는 언어는 더 깊은 구조를 얻는다.** Analyzer가 없거나 얕으면 분석의 확신이 낮아질 뿐 DUO가 실패하거나 WARN/BLOCK이 생기지 않는다.

## Analysis Level

Level은 capability에서 계산한다(`analysisLevelOf`, analyzer `language/types.ts`). 따로 선언하는 값이 아니고 점수도 아니다.

| Level | 뜻 | 누가 |
|---|---|---|
| L0 | 파일: RepoPath, fingerprint, Git history·diff, Project Truth 참조(`implements.paths`, `governs.paths`, `forbids.paths`), Evidence, file 수준 Context·Review | 모든 Git repository의 모든 indexed 파일 |
| L1 | 구조: Symbol, Test, import/include/using(쓰인 그대로), call site, 정확한 SourceLocation. 일부 참조는 확실할 때만 파일로 해석 | Java, C#, C++, Python |
| L2 | 부분 의미: 모든 import를 module resolver가 결정하고, binding으로 확실한 CALLS | TypeScript, JavaScript |
| L3 | type resolution | 없음 |

## AnalyzerCapabilities

`LanguageAnalyzer.capabilities`(analyzer `language/types.ts`, `CAPABILITY_CONTRACT_VERSION = "1"`)가 관계별로 어디까지인지 말한다. Graph Edge가 없다는 것은 "관계가 없다"가 아니라 "현재 Analyzer로 확정할 수 없다"일 수 있으므로, Context·Review·Impact는 이 값을 limitation으로 전달한다.

- `symbols`, `tests`: `none | structural`
- `imports`: `none | syntactic | partial | resolved` — syntactic은 쓰인 그대로만, partial은 일부 repository-local 참조가 파일로 해석됨, resolved는 resolver가 모든 참조를 결정
- `calls`: `none | syntactic | partial | exact` — syntactic은 CALLS Edge 없음, partial은 syntax로 확실한 대상만 Edge
- `typeResolution`: `none | partial | full`
- `callResolution`(전략): `module-bindings`(TS/JS 규칙) · `same-file-functions`(같은 파일의 유일한 top-level/namespace 함수에 대한 bare call) · `none`

## 언어별 지원

| Language | L0 | Symbols | Tests | Imports | Calls | Semantic resolution | Known limitations |
|---|---|---|---|---|---|---|---|
| TypeScript / TSX / JavaScript | ✓ | class, interface, type alias, enum, function, method, constructor, accessor | vitest, jest, node:test(import binding) | resolved: TypeScript Compiler API module resolution(tsconfig/jsconfig, paths, exports) | partial: import binding·export index·`this` member로 확실한 CALLS | L2 일부. type checker 없음 | instance·dynamic·injected call은 Edge 없음 |
| Java | ✓ | class, interface, enum, record, method, constructor(중첩 소유 유지). package는 qualifier | JUnit 4 `@Test`, JUnit 5 `@Test`/`@ParameterizedTest`/`@RepeatedTest`/`@TestFactory`/`@TestTemplate`: import binding이 있을 때 explicit, `src/test/`의 import 없는 `@Test`만 heuristic | syntactic: `import`, `import static`, wildcard(쓰인 그대로) | syntactic: call site만, CALLS 없음 | 없음(javac, classpath, Maven/Gradle 해석 없음) | 파일 간 IMPORTS·CALLS Edge 없음 |
| C# | ✓ | class, struct, interface, enum, record, delegate, method, constructor, destructor, property. namespace(블록·file-scoped)는 qualifiedName | NUnit `[Test]`/`[TestCase]`/`[TestCaseSource]`/`[Theory]`, Unity `[UnityTest]`, xUnit `[Fact]`/`[Theory]`, MSTest `[TestMethod]`/`[DataTestMethod]`: 해당 `using`이 있을 때만 | syntactic: `using`, `using static`, `global using`, alias | syntactic: call site만, CALLS 없음 | 없음(Roslyn, MSBuild, NuGet 없음) | partial class는 같은 qname의 여러 선언을 그대로 둔다(병합하지 않음) |
| C++ | ✓ | namespace, class, struct, enum, free function, method(클래스 안·밖 정의), constructor, destructor. template 선언 안의 소유 유지. Unreal `UCLASS`/`GENERATED_BODY`/`UFUNCTION`/`UPROPERTY`/`*_API`는 같은 길이 공백으로 가려 parse(위치 불변) | GoogleTest `TEST`/`TEST_F`/`TEST_P`/`TYPED_TEST`, Catch2 `TEST_CASE`/`SCENARIO`, Unreal `IMPLEMENT_*_AUTOMATION_TEST`: framework include가 있으면 explicit, test 경로면 heuristic | partial: `#include "…"`가 포함한 파일 옆에 있으면 IMPORTS, `<…>`는 system | partial: 자유 함수 안의 bare call이 같은 파일의 유일한 함수일 때만 CALLS | 없음(clang, compile_commands, CMake, Unreal Build.cs 해석 없음) | include path(-I, Unreal Public/Private 모듈)는 해석 안 함, overload·template·macro·member call은 추측하지 않음, field는 Symbol이 아님 |
| Python | ✓ | class, function, async function, method(중첩 소유 유지). decorator는 source range에 포함 | pytest: `test_*.py`·`*_test.py`의 `test_*` 함수와 `Test*` class method. unittest: `unittest.TestCase` subclass의 `test_*` method(어느 파일이든) | partial: 상대 import, repository root 또는 `src/` 아래의 absolute module | partial: bare call이 같은 module의 유일한 함수일 때만 CALLS | 없음(interpreter, Pyright/mypy, virtualenv 없음) | 설치 package·stdlib는 external, 다른 module의 함수 호출은 Edge 없음 |
| 그 밖의 모든 파일 | ✓ | 없음 | 없음 | 없음 | 없음 | 없음 | L0만: file node, Truth path 참조, Git evidence, head window Context, file 수준 Review |

`duo:` annotation은 모든 L1 언어의 주석에서 읽는다(`//`, `/* */`, Python `#`).

## 언어 판별

파일마다 고른다(Project당 Analyzer 하나가 아님). 확장자: `.ts .mts .cts` TypeScript, `.tsx` TSX, `.js .mjs .cjs .jsx` JavaScript, `.java` Java, `.cs` C#, `.py` Python, `.cpp .cc .cxx .hpp .hh .hxx` C++.

`.h`는 C일 수도 C++일 수도 있다. **header rule**(analyzer `registry.ts` `isCppHeader`): repository에 `*.uproject`가 있거나, 같은 stem의 `.cpp/.cc/.cxx`가 옆에 있거나, C++ 파일이 있고 `.c` 파일이 없으면 C++이다. 아니면 generic file(L0)로 둔다. CMakeLists.txt는 C 프로젝트에도 있으므로 근거로 쓰지 않는다.

## Analyzer Registry와 무효화

- `AnalyzerRegistry.scope(paths)`가 repository 파일 집합으로 파일별 Analyzer·capability·language를 고른다. 새 언어는 LanguageAnalyzer 하나를 등록하면 되고 Indexer, Graph Builder, Context Compiler, Review는 바뀌지 않는다.
- **analyzer identity**: sha256(id, version, capability contract version, extensions, contextual extensions, call strategy, capabilities, grammar WASM의 sha256). **registry digest**: 모든 identity와 selection rule version의 sha256.
- Index State(v4)는 파일별로 분석한 Analyzer identity를 기록하고 analysis cache(v2)의 key도 identity다. 그래서 Java Analyzer가 추가되면 전에 file-only였던 `.java`만 다시 parse하고, identity가 그대로인 TS 파일은 재사용한다. registry digest는 coverage·status·Adoption Baseline에 기록한다.
- Grammar는 registry를 만들 때 한 번 load하고 모든 파일에 재사용한다.

## Stack profile (init, observed)

`duoctl init`의 `observed.stack`(director `init/stack.ts`). manifest 사실만 쓰고 source 패턴은 쓰지 않는다. **관찰이며 Truth가 아니다**: Requirement·Constraint·Decision을 만들지 않는다.

- ecosystem: maven(`pom.xml`), gradle(`build.gradle(.kts)`, `settings.gradle(.kts)`), dotnet(`*.sln`, `*.csproj`), unity(`ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json`), cmake(`CMakeLists.txt`), unreal(`*.uproject`, `*.uplugin`, `*.Build.cs`, `*.Target.cs`), python(`pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `Pipfile`, `poetry.lock`, `uv.lock`), npm
- framework: Spring Boot(pom/gradle의 spring-boot starter·parent·plugin), Unity(`m_EditorVersion` → version, 또는 `com.unity.*` package), Unreal(`EngineAssociation` → version, uplugin, module rules), FastAPI(Python manifest의 `fastapi` 의존성; `fastapi-users` 같은 다른 이름은 아님)

## Build output 제외 (scanner)

scanner는 Git이 추적하는 파일과 ignore되지 않은 untracked 파일을 본다. 아래 디렉터리는 근거가 있을 때만 `build-output`으로 제외한다(analyzer `scan/build-output.ts`). 근거가 없으면 같은 이름의 source 디렉터리는 그대로 index한다.

| 근거 | 제외 |
|---|---|
| 이름만(항상 도구 cache) | `.gradle/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `site-packages/` |
| 안에 `pyvenv.cfg` | 가상환경 디렉터리(`.venv/`, `venv/`, …) |
| 옆에 `pom.xml` 또는 `build.gradle(.kts)` | `target/` |
| 옆에 Gradle build/settings 파일 | `build/` |
| 안에 `CMakeCache.txt` | CMake build 디렉터리 |
| 옆에 `*.csproj` | `bin/`, `obj/` |
| 옆에 `ProjectSettings/ProjectVersion.txt` | Unity `Library/`, `Temp/`, `Logs/`, `obj/` |
| 옆에 `*.uproject`/`*.uplugin` | `Binaries/`, `Intermediate/`, `Saved/`, `DerivedDataCache/` |

## Context와 Review

- **Context**: Analyzer가 있는 파일은 Symbol·Test의 정확한 range를 쓴다. generic file 후보의 L2는 **head window**: 처음 40줄과 2,000자 중 먼저 닿는 곳까지의 온전한 줄(한 줄이 더 길면 그 줄을 surrogate pair를 깨지 않고 자름), 파일 전체는 넣지 않는다. Packet의 limitations에 후보 코드의 capability 한계가 들어간다: `structural-analysis-unavailable`, `imports-syntactic`, `imports-partial`, `calls-unresolved`, `calls-same-file`. Python은 `#` 주석 줄도 leading context다. CONTEXT_POLICY_VERSION 2.
- **Review**: 변경된 파일의 limitation이 같은 code로 붙는다(문서·데이터 파일 제외). Analyzer가 없다는 이유로 claim이 생기지 않는다: scope drift는 structural 파일만 보고, test-coverage는 바뀐 구현 파일 중 test를 볼 수 있는 언어가 없으면 PARTIAL 대신 UNKNOWN(`tests-not-analyzable`, 경고 아님)이다. PASS의 뜻은 그대로: 가진 evidence 범위에서 방향 위반을 찾지 못함.
- **Impact**: 관련 파일 언어의 limitation을 `limitations`로 더한다(Graph에 기록된 관계만).
- **Adoption Baseline**: `analysis.structuralLanguages`와 registry digest를 기록한다(T18.0 이전 record는 TS/JS로 본다). baseline을 다시 해석하지 않는다. baseline 당시 구조 분석이 없던 언어의 Symbol 위반이 baseline에 없으면 provenance `unverified-at-adoption`: 경고는 하되 BLOCK하지 않는다.
- **의미 보조(T12B)**: `duoctl review --semantic`은 언어와 무관하다. 후보 claim과 이미 수집한 Evidence 발췌만 보내고 adapter에 언어별 분기가 없다. L0 파일도 요청할 수 있지만 LLM에게 Symbol이나 호출 관계를 추측하게 하지 않는다: LLM은 결정적 Evidence의 의미만 해석한다. OpenAI 설정이 없으면 모든 언어의 init, index, context, review가 `llmCalls = 0`이다(언어별 CLI e2e).
- Cross-language 관계(TS frontend → HTTP → Java backend)는 추측하지 않는다. Project Truth가 명시한 관계만 Edge가 된다.

## Grammar

모두 공식 tree-sitter grammar의 npm package에 들어 있는 WASM을 쓴다. 이 package들은 `node-gyp-build` install script가 있으므로 runtime dependency로 두지 않고, 배포본은 WASM과 MIT license를 `dist/grammars/`에 vendoring하며 `grammars.json`에 package·version·repository·license·sha256·bytes·ABI를 적는다. web-tree-sitter 0.27.0(ABI 13~15)에서 실제 load·parse를 테스트한다(analyzer `grammars.test.ts`, 배포 E2E).

| grammar | package | ABI | WASM bytes |
|---|---|---|---|
| typescript, tsx | tree-sitter-typescript 0.23.2 | 14 | 1,413,849 / 1,445,638 |
| javascript | tree-sitter-javascript 0.25.0 | 15 | 411,770 |
| java | tree-sitter-java 0.23.5 | 14 | 414,641 |
| csharp | tree-sitter-c-sharp 0.23.5 | 15 | 5,350,581 |
| cpp | tree-sitter-cpp 0.23.4 | 14 | 3,434,931 |
| python | tree-sitter-python 0.25.0 | 15 | 457,883 |

## 하지 않는 것

javac·Maven/Gradle 실행, Roslyn·MSBuild, clangd/libclang·Unreal Header Tool·CMake 평가, Python interpreter·Pyright·virtualenv import graph, cross-language REST/RPC 연결, LLM에 source를 보내는 분석. 전체 cross-language workflow는 `llmCalls = 0`이다.
