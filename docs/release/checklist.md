# Release checklist

`pnpm release:preflight`가 아래 항목을 검사하고 `.dist/release-preflight.json`(`duo.release-preflight/1`)에 blocker를 기록한다. preflight는 version을 바꾸거나 commit·tag·npm scope 생성·publish를 하지 않는다. 마지막 npm 단계는 `npm publish --dry-run`이다.

## 명령

| 명령 | 내용 | network |
|---|---|---|
| `pnpm release:lock` | `apps/cli/npm-shrinkwrap.json` 재생성(의존성 변경 시). diff를 검토해 커밋 | 필요 |
| `pnpm release:pack` | clean tree 확인 → build → pack → `.dist/release-candidate.json`(commit, branch, clean, version, hash). dirty면 거부(`DUO_RELEASE_ALLOW_DIRTY=1`은 시험용) | 불필요 |
| `pnpm release:audit` | shrinkwrap 트리의 npm advisory와 deprecated 검사 → `.dist/release-audit.json` | 필요 |
| `pnpm release:preflight` | git·CI → verify, grammar, benchmark smoke, 배포 E2E → release:pack → 재현성 → metadata·allowlist·secret·절대경로 → dependency·license → npm identity·registry·scope·version → `npm publish --dry-run` → OpenAI smoke 결과(선택 검증, blocker 아님) | 필요 |
| `pnpm test:openai-smoke` | 선택: 실제 OpenAI Responses 호출(공식 `api.openai.com`, `DUO_OPENAI_SMOKE=1`, `OPENAI_API_KEY`, `DUO_OPENAI_SMOKE_MODEL`). `.dist/openai-smoke.json`에 commit, model, 확인 항목만 기록 | 필요 |
| `pnpm test:conformance` | RC를 격리 prefix에 설치 → shrinkwrap 트리·notices → C209 init 반복(`DUO_C209_RUNS`, 기본 20) → 설치된 duoctl로 CLI·MCP·install journey와 RC 전용 검사 → 문서·help 대조 → `.dist/release-conformance.json` | 필요(npm install) |
| `pnpm release:verify-published` | publish **뒤** 확인(T21): registry의 name·version·integrity·license·engines·bin → 빈 npm 설정과 새 cache로 임시 prefix에 `npm install -g` → 설치된 파일 수·LICENSE·shrinkwrap → PATH의 `duoctl --version`·`--version --json`·`--help` → 새 Git 저장소에서 `init`→`status` → origin의 `v<version>` tag commit → GitHub Release(draft 아님) → `.dist/release-published.json`. 기대 integrity와 commit은 `--integrity`·`--commit` 또는 같은 version의 `.dist/release-candidate.json`. publish·tag·login을 하지 않고 npm credential을 읽지 않는다. CI와 `pnpm verify`에는 넣지 않는다 | 필요 |

## 0.1.1 (H-46, 준비 중)

Patch release: 사람용 CLI 안내 3개, 테스트, release tooling, 문서([release notes](notes-0.1.1.md)). 공개 형식, 명령 의미, exit code, Truth 형식은 0.1.0과 같다. 성능 후보와 새 기능은 넣지 않는다([0.1.1 hardening](../roadmap/0.1.1-hardening.md)).

- [x] version 0.1.0 → 0.1.1: `apps/cli/package.json`, `apps/cli/npm-shrinkwrap.json`의 package version 두 곳. 의존성 트리는 바꾸지 않았다(`release:lock`을 다시 실행하지 않음)
- [x] 안내 문구 regression test(`tests/cli/first-run.e2e.test.ts`, 설치본 conformance에도 포함), `--json` 출력이 0.1.0과 byte 단위로 같음
- [ ] full CI(3 OS), `pnpm release:preflight` READY, `npm publish --dry-run`
- [ ] 사람이 publish, tag, GitHub Release를 실행한 뒤 `pnpm release:verify-published`

## 0.1.0 상태 (H-45 결정 반영 commit 기준, 2026-09-30 release)

`pnpm release:preflight`가 blocker를 **code**(이 저장소에서 고치는 것, `codeReady`)와 **external**(사람이 저장소 밖에서 하는 계정·설정 작업, `externalReady`)로 나눠 계산하고 각 blocker의 다음 조치를 보여 준다. readiness는 둘 다 충족될 때만 READY다. 외부 항목이 남아 있으면 BLOCKED이며 코드나 artifact가 출시 불가능하다는 뜻이 아니다.

### Code / Artifact

- [x] Full CI(3 OS: verify, grammar, benchmark smoke, 배포 E2E, conformance)
- [x] Conformance(설치된 RC로 CLI·MCP·install journey와 RC 전용 검사, [product-contract](product-contract.md))
- [x] LICENSE(Apache-2.0 원문, package metadata `Apache-2.0`, package에 포함)
- [x] SECURITY policy document(`SECURITY.md`: GitHub Private Vulnerability Reporting)
- [x] Shrinkwrap(설치 트리 = `npm-shrinkwrap.json`)
- [x] Third-party notices(React, react-dom, scheduler, grammar, runtime dependency)
- [x] `npm publish --dry-run`(목록 = release candidate)
- [x] Final artifact E2E(clean global·local install, MCP, UI, polyglot, LLM 없음)
- [x] Docs conformance(README·07·`--help`, 옛 설계 표현 0)
- [x] README 설치 흐름(root README와 package README의 기본 설치는 `npm install -g @duo-director/cli`, tarball은 From source)
- [x] NFR decision(REQ-NFR-004 benchmark-scoped target, H-44)
- [x] `release:audit`(advisory 0, deprecated 0), 재현성, secret·절대경로 0, `@duo-director/cli@0.1.0` 미존재

### Human / External

- [x] npm login(`npm-auth`)
- [x] `@duo-director` scope publish 권한(`npm-scope-access`, DP-3: organization owner)
- [x] GitHub 저장소 public 전환(`repository-not-public`, package 링크 도달)
- [x] GitHub Private Vulnerability Reporting 활성화(`github-private-vulnerability-reporting`)

### Deferred / Optional integration verification (H-45)

0.1.0 release blocker가 아니다. preflight는 결과가 있으면 `openaiSmoke`에 기록하지만 readiness에 넣지 않는다.

- [ ] 실제 OpenAI smoke(`pnpm test:openai-smoke`, 공식 OpenAI API key 필요, fake 테스트는 대신하지 않음, C208)
- [ ] OpenAI-compatible endpoint(GMS 등) 지원은 0.1.0 이후 별도 Provider(C212). `OpenAIResponsesProvider`는 공식 endpoint 전용으로 유지한다

## Publish 명령 (문서화만, 사람이 명시적으로 요청한 뒤에만 실행)

```bash
pnpm release:preflight          # blocker 0이어야 한다
npm publish .dist/duo-director-cli-0.1.1.tgz --access public --registry https://registry.npmjs.org/
git tag -a v0.1.1 -m "DUO 0.1.1" <release candidate commit> && git push origin v0.1.1
pnpm release:verify-published   # GitHub Release를 만든 뒤
```

0.1.0은 `npm publish .dist/duo-director-cli-0.1.0.tgz …`와 `v0.1.0`(`04bab58`)으로 게시했다.

README와 package README는 publish 전에 이미 npm registry 설치 흐름으로 바뀌어 있고, 그 문서 전환 commit이 final release candidate다. publish 뒤 문서를 다시 바꿀 필요는 없다. GitHub Release는 tag를 push한 뒤 따로 만든다.

publish 전후 검증은 짝을 이룬다. publish 전에는 `pnpm release:preflight`(READY, blocker 0), publish·tag push·GitHub Release 뒤에는 `pnpm release:verify-published`(ok)를 실행한다. 0.1.0은 2026-09-30에 이 스크립트로 다시 확인했다: registry integrity가 RC와 같고, 설치된 `duoctl 0.1.0`이 새 저장소에서 init·status를 마쳤으며(index current, LLM disabled), `v0.1.0`은 `04bab58`, GitHub Release는 게시 상태다.

## 알려진 limitation

- Windows에서 설치 직후 첫 명령이 오래 걸릴 수 있다(기준 환경 17~19 s, 이후 1.4~1.5 s). 새로 설치된 JavaScript 파일의 첫 open 비용이며 DUO 작업과 무관하다([performance-benchmark](../performance-benchmark.md#설치-직후-첫-실행-release-hardening)).
- shrinkwrap을 쓰므로 transitive dependency의 보안 수정은 새 DUO release 전까지 반영되지 않는다(C163).
