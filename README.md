# DUO

**AI Project Direction Layer for Coding Agents**

> Human defines intent. Agent performs implementation. DUO maintains direction.

DUO는 Codex, Claude Code 같은 AI Coding Agent가 프로젝트의 목표와 결정사항에서 벗어나지 않게 돕는 로컬 도구입니다. DUO는 코드를 작성하지 않습니다. 하는 일은 네 가지입니다.

- **Project Direction**: 사람이 확정한 목표, 요구사항, Decision을 `.duo-project/`에 Project Truth로 둡니다. Agent는 제안만 하고 확정은 사람이 합니다.
- **Deterministic evidence**: 파일, Git history, 코드 구조를 결정적으로 분석해 Graph와 근거(Evidence)를 만듭니다.
- **Context Compiler**: 작업에 필요한 Truth, 코드, 테스트만 골라 작은 Context Packet으로 Agent에게 줍니다.
- **Drift Review**: 변경을 확정된 방향과 대조해 PASS / WARN / BLOCK / ASK를 근거와 함께 보고합니다.

LLM은 선택 사항입니다. API key 없이도 index, Context, Review, MCP, UI가 모두 동작하고, 기본값에서는 네트워크를 쓰지 않습니다.

## 빠른 시작

Node.js 24.15 이상이 필요합니다. native build나 install script는 없습니다.

```bash
npm install -g @duo-director/cli

cd existing-project
duoctl init
duoctl install codex
# optional
duoctl ui
```

Claude Code를 쓴다면 `duoctl install codex` 대신 `duoctl install claude-code`를 실행합니다. source에서 만든 package로 설치하는 방법은 [From source](#from-source)에 있습니다.

`duoctl init`은 이미 있는 저장소에서 시작합니다. 저장소를 관찰하고, 꼭 필요한 질문만 사람에게 묻고, 최소한의 Project Truth를 만들고, 첫 index를 만든 뒤, 지금 상태를 Adoption Baseline으로 기록합니다. 그래서 도입 전부터 있던 문제와 도입 후 새로 생긴 문제를 구분합니다. 처음부터 DUO로 만든 프로젝트가 아니어도 됩니다. 작업 중인 변경이 있으면 `--baseline-policy head|abort` 중 하나를 고릅니다.

`duoctl install codex`와 `duoctl install claude-code`는 바꿀 파일을 먼저 보여 주고, 확인하면 MCP 설정(`.codex/config.toml` 또는 `.mcp.json`)과 짧은 안내 블록(`AGENTS.md` 또는 `CLAUDE.md`)을 추가한 뒤 DUO 서버가 실제로 뜨는지 확인합니다. 기존 설정과 사람이 쓴 글은 그대로 두고, commit은 직접 합니다. Codex는 이 project를 trust해야 하고 Claude Code는 `duo-director` 서버 승인을 묻습니다. DUO는 둘 다 대신하지 않습니다. `duoctl install status`로 연결 상태를, `duoctl install remove <agent>`로 DUO가 추가한 항목만 제거합니다. project 안에만 설치했다면 `--launcher npx`를 줍니다.

`duoctl ui`는 `127.0.0.1`에서 로컬 Console을 열고 출력된 URL로 접속합니다. UI는 현재 index를 읽기만 하므로 `index-required`가 보이면 `duoctl index`를 실행하고 Refresh합니다. UI에서 바꿀 수 있는 Truth는 사람의 Decision Confirm/Reject뿐입니다.

Windows에서는 설치 직후 첫 명령이 오래 걸릴 수 있습니다(기준 PC에서 약 18초, 이후 약 1.5초). 새로 설치된 JavaScript 파일을 처음 열 때 드는 외부 비용이며 한 번만 생깁니다([측정](docs/performance-benchmark.md#설치-직후-첫-실행-release-hardening)).

## 지원 범위

| 수준 | 대상 | 하는 일 |
|---|---|---|
| L0 | 모든 Git repository의 모든 파일(분석기 없는 언어 포함) | 파일, fingerprint, Git history와 diff, Project Truth 참조, 파일 수준 Context와 Review |
| L1 | TypeScript / JavaScript / Java / C# / C++ / Python | Symbol, Test, import·include·using, call site, 정확한 source 위치 |
| L2 | TypeScript / JavaScript | 모든 import의 module resolution, binding으로 확실한 CALLS |

모든 언어를 의미 수준으로 이해한다는 뜻은 아닙니다. Analyzer가 없거나 얕은 언어에서는 확신이 낮아질 뿐 DUO가 실패하거나 WARN·BLOCK이 생기지 않습니다. 자세한 범위와 한계는 [docs/language-support.md](docs/language-support.md)에 있습니다.

## Benchmark

수치는 한 기준 환경(Windows 11, Intel Core Ultra 7 155H, Node 24.18)과 DUO의 synthetic fixture `duo-bench-fixture/1`에서 잰 값이며 다른 프로젝트나 성능 보장으로 일반화하지 않습니다. 방법과 전체 결과는 [docs/performance-benchmark.md](docs/performance-benchmark.md)에 있습니다.

- On DUO's synthetic 5,000-source-file fixture on Windows 11 / Core Ultra 7 155H, the `AUTH-03` packet contained 2,023 o200k_base tokens from a 137,048-token analyzed source corpus and included all expected entities (Requirement, Decision, Symbol, Test). 100개 파일 fixture에서도 같은 Packet(같은 digest)이 나옵니다.
- 같은 fixture에서 Packet은 관련 파일 원문 합(1,602 token)보다 26% 큽니다. 절감은 저장소 전체를 읽는 경우와 비교한 값입니다.
- 같은 환경의 5,000파일 fixture에서 장기 실행(MCP·UI) `context`는 약 2.5초, `review`는 약 3.9초, 파일 하나를 바꾼 뒤 `index`는 약 2.4초입니다. 대부분은 결과를 정확하게 유지하려고 매 호출 수행하는 freshness 확인입니다.

## 사용

```bash
duoctl status
duoctl context "작업 설명"
duoctl index        # 코드를 바꾼 뒤
duoctl review
```

### LLM은 선택 사항입니다

LLM is optional. DUO's indexing, context selection and deterministic review work without an API key. 기본값은 꺼짐(`llm.provider: none`)이고, 켜지 않으면 네트워크 호출이 없습니다. 켜려면 `.duo-project/project.yaml`에 provider와 model을 명시하고 key는 환경 변수로만 줍니다(파일에 쓰지 않음).

```yaml
llm:
  provider: openai-responses   # 공식 OpenAI Responses API
  model: <사용할 model ID>      # DUO는 model을 고르지 않습니다
```

```bash
OPENAI_API_KEY=... duoctl review --semantic
```

`openai-responses`는 공식 OpenAI API(`api.openai.com`)에만 연결합니다. 실제 OpenAI API 연동 smoke는 release gate에 포함되지 않은 선택 검증입니다.

`--semantic`(MCP `includeSemanticAssist: true`)을 줄 때만 Review의 의미 후보를 한 번 확인합니다. 이때 **선택된 Evidence 발췌(관련 Truth 문단, 바뀐 코드 부분, diff hunk)가 OpenAI API로 전송됩니다**. 파일 전체나 저장소는 보내지 않고, `store: false`로 요청합니다. 결과는 별도 `semanticAssist`로 붙고 결정적 판정을 바꾸거나 BLOCK을 만들지 않습니다. 같은 요청의 검증된 응답은 로컬 `.duo-project/cache/llm/`에 저장되며(`llm.cache: false`로 끔), 이것은 OpenAI 서버 저장과 별개입니다.

Agent는 MCP Tool 9개(`duo_get_status`, `duo_get_context`, `duo_review_changes`, `duo_get_requirement`, `duo_get_decision`, `duo_trace`, `duo_impact`, `duo_search_evidence`, `duo_propose_decision`)를 씁니다. Agent는 Decision을 제안만 할 수 있고 확정과 거절은 사람이 `duoctl decision`으로 합니다. Tool은 인덱싱하지 않으므로 `index-required`를 받으면 `duoctl index`를 실행합니다. 명령은 [07-cli-interface.md](docs/07-cli-interface.md), MCP와 설치 계약은 [06-mcp-interface.md](docs/06-mcp-interface.md)에 있습니다.

## 개발

Node.js 24(`>=24.15.0`)와 pnpm 11이 필요합니다.

```bash
pnpm install
pnpm verify        # check:boundaries → lint → typecheck → build → test → docs:validate
pnpm duoctl --version
```

| 명령 | 내용 |
|---|---|
| `pnpm check:boundaries` | 패키지 의존 방향(package.json, tsconfig references) 검사 |
| `pnpm lint` | ESLint(패키지 경계, `node:sqlite` 격리 포함) |
| `pnpm typecheck` | 테스트를 포함한 전체 타입 검사 |
| `pnpm build` | `tsc -b` project references 빌드 |
| `pnpm test` | Vitest |
| `pnpm docs:validate` | Requirement/ADR/Task/AC 추적성 검사 |
| `pnpm pack:cli` | 배포 package(`.dist/cli-package/`)와 tarball 생성(publish는 하지 않음) |
| `pnpm test:dist` | tarball을 임시 prefix·project에 설치해 배포본만으로 E2E(npm registry 접근 필요) |
| `pnpm release:pack` · `release:preflight` · `release:audit` · `release:lock` | release tarball 생성과 검사([checklist](docs/release/checklist.md), publish는 하지 않음) |
| `pnpm release:verify-published` | publish한 version을 registry에서 받아 임시 prefix에 설치하고 확인(integrity, `duoctl --version`, init·status, tag, GitHub Release) |
| `pnpm benchmark:smoke` | 100파일 fixture benchmark와 결과 계약 검사(CI) |
| `pnpm benchmark` | 100/1,000/5,000파일 full benchmark, 결과는 Git 제외 `bench/results/local/` |

### From source

이 저장소에서 package tarball을 만들어 설치합니다. npm registry의 package와 같은 구성입니다.

```bash
pnpm install && pnpm release:pack          # .dist/duo-director-cli-0.1.1.tgz
npm install -g .dist/duo-director-cli-0.1.1.tgz
```

## License와 보안

DUO는 [Apache License 2.0](LICENSE)으로 배포합니다. 배포 package에 들어 있는 제3자 소프트웨어(UI에 bundle된 React 등, Tree-sitter grammar, npm 의존성)의 license는 `dist/THIRD_PARTY_NOTICES.md`와 `dist/grammars/LICENSE-*`에 따로 있습니다.

보안 취약점은 공개 Issue로 올리지 말고 GitHub Private Vulnerability Reporting으로 신고해 주세요([SECURITY.md](SECURITY.md)).

## 문서

- [문서 지도](docs/README.md)
- [제품 비전](docs/00-product-vision.md) · [요구사항](docs/01-requirements.md) · [아키텍처](docs/02-system-architecture.md)
- [충돌 및 미결 사항](docs/conflicts.md)
- Release: [checklist](docs/release/checklist.md) · [제품 계약](docs/release/product-contract.md) · [결정 요청](docs/release/decision-packets.md) · [호환성 계약](docs/release/compatibility.md) · [benchmark](docs/performance-benchmark.md)
- [ADR](docs/adr/README.md)

## 원본 입력

- [Duo 기획서.md](Duo%20기획서.md): 제품 기획서
- [docs/references/development-directive.md](docs/references/development-directive.md): 개발 지시문
