# Release checklist

`pnpm release:preflight`가 아래 항목을 검사하고 `.dist/release-preflight.json`(`duo.release-preflight/1`)에 blocker를 기록한다. preflight는 version을 바꾸거나 commit·tag·npm scope 생성·publish를 하지 않는다. 마지막 npm 단계는 `npm publish --dry-run`이다.

## 명령

| 명령 | 내용 | network |
|---|---|---|
| `pnpm release:lock` | build-time release lock `apps/cli/npm-shrinkwrap.json` 재생성(의존성·version 변경 시, H-65). 기존 lock을 seed로 써서 바뀌어야 하는 항목만 다시 고른다. diff를 검토해 커밋 | 필요 |
| `pnpm release:pack` | clean tree 확인 → build → pack(release lock을 격리 `npm ci`로 설치해 `node_modules/`에 bundle, `dist/runtime-tree.json`) → `.dist/release-candidate.json`(`duo.release-candidate/2`: commit, branch, clean, version, hash, runtime tree). dirty면 거부(`DUO_RELEASE_ALLOW_DIRTY=1`은 시험용) | 필요(release lock 설치, npm cache가 있으면 cache) |
| `pnpm release:audit` | source: release lock의 npm advisory와 deprecated 검사. artifact: pack한 runtime tree(`dist/runtime-tree.json`)가 그 lock과 같은 package(경로·version·integrity)인지 → `.dist/release-audit.json`(`duo.release-audit/2`) | 필요 |
| `pnpm release:preflight` | git·CI → verify, grammar, benchmark smoke, 배포 E2E → release:pack → 재현성 → metadata·allowlist·secret·절대경로 → dependency·license → npm identity·registry·scope·version → `npm publish --dry-run` → OpenAI smoke 결과(선택 검증, blocker 아님). 검증 단계에 `release:upgrade`가 포함된다 | 필요 |
| `pnpm release:upgrade` | upgrade journey(T28): registry의 이전 version(기본 0.2.0)과 RC를 격리 prefix 두 곳에 설치 → 이전 version이 TypeScript·Python·C++·sparse 저장소를 도입(0.1.x project.yaml 변형 A~E, Codex 연결) → RC 설치본으로 `--version`·status·doctor·index·status(current)·context·review·install verify. 이전 index가 stale·incompatible이면 index 한 번으로 current, current로 보고되면 다음 index가 parse 0·Graph 쓰기 없음이어야 한다 → Truth byte·baseline·re-init·migration 확인 → `.dist/release-upgrade.json`. preflight가 이 commit·RC의 성공 결과를 요구한다 | 필요(이전 version 설치) |
| `pnpm test:openai-smoke` | 선택: 실제 OpenAI Responses 호출(공식 `api.openai.com`, `DUO_OPENAI_SMOKE=1`, `OPENAI_API_KEY`, `DUO_OPENAI_SMOKE_MODEL`). `.dist/openai-smoke.json`에 commit, model, 확인 항목만 기록 | 필요 |
| `pnpm test:conformance` | RC를 격리 prefix에 설치 → runtime tree(설치 트리 = `dist/runtime-tree.json`, package 밖 설치 0)·notices → C209 init 반복(`DUO_C209_RUNS`, 기본 20) → 설치된 duoctl로 CLI·MCP·install journey와 RC 전용 검사 → 문서·help 대조 → `.dist/release-conformance.json` | 필요(npm install) |
| `pnpm release:verify-published` | publish **뒤** 확인(T21): registry의 name·version·integrity·license·engines·bin → 빈 npm 설정과 새 cache로 임시 prefix에 `npm install -g` → 설치된 파일 수(bundled `node_modules/` 포함, npm이 만든 `.bin` 제외)·LICENSE·runtime tree(0.2.1부터 설치 트리 = `dist/runtime-tree.json`, 그 전 version은 `npm-shrinkwrap.json` 존재) → PATH의 `duoctl --version`·`--version --json`·`--help` → 새 Git 저장소에서 `init`→`status` → origin의 `v<version>` tag commit → GitHub Release(draft 아님) → `.dist/release-published.json`. 기대 integrity와 commit은 `--integrity`·`--commit` 또는 같은 version의 `.dist/release-candidate.json`. publish·tag·login을 하지 않고 npm credential을 읽지 않는다. CI와 `pnpm verify`에는 넣지 않는다 | 필요 |

## 0.2.2 (H-75, C243, C244)

Correctness patch([release notes](notes-0.2.2.md), [호환성 분류](compatibility.md#022-변경-분류-t43-h-75)). v0.2.1에서 만든 `release/0.2.2`에 `next`의 T40 N1 수정만 backport했다. 권위 있는 작업은 일부만 읽힌 Project Truth에서 실행하지 않고 `PROJECT_TRUTH_INVALID`로 실패한다. H-71, Informed Confirm, `imported_paths`, provenance 표시(H-73), explicit seed(H-76) 등 0.3 기능은 넣지 않는다. External Validation 01은 계속 정확히 0.2.1이다.

- [x] backport: v0.2.1 위에 `0c59d47` cherry-pick, 충돌 3곳(import 줄, message, diagnostic persistence)은 0.2.1 줄을 유지하고 N1 줄만 넣음
- [x] correctness test: core `authority.test.ts`, e2e `tests/cli/truth-fail-closed.e2e.test.ts`(0.3 전용 `imported_paths`, 모르는 field, 잘못된 YAML·타입, 깨진 proposal: review·context 종료 1과 verdict 없음, `--fail-on`도 실패, status `truth.errors`, doctor invalid, decision list, Decision confirm·reject 거부, MCP `isError`, UI review route failed, Truth 파일 불변, 고친 Truth는 다시 BLOCK)
- [x] 정상 저장소: 공개 0.2.1 설치본과 0.2.2 build의 review·context JSON이 같음(WARN·BLOCK 두 경우, 실행 시간 field만 다름)
- [x] version 0.2.1 → 0.2.2: `apps/cli/package.json`, release lock의 package version 두 곳(의존성 트리 불변), README·07의 현재 version 예시
- [x] 로컬 `pnpm verify`(101 files, 1,020 pass / 7 skip)
- [x] release tooling: `release:upgrade`가 status `truth` 객체 전체를 비교해 additive `truth.errors: []` 때문에 실패했다. 개수 field(requirements·decisions·constraints·declaredGaps)만 비교하고 RC의 `truth.errors`가 비어 있는지 따로 확인하도록 고침(제품 출력 불변). upgrade journey 공개 0.2.1 → RC: ts·python·cpp·sparse 모두 current, Truth 불변
- [x] RC tarball 설치 matrix(Windows, Node 24.18.0): npm 10.9.9·11.21.0·12.2.0 global, npm 11.21.0 project-local 4칸 모두 `duoctl 0.2.2`, 설치 트리 = `dist/runtime-tree.json`(67 package, 불일치·package 밖 설치 0), doctor, MCP tool 9개, 정상 review BLOCK과 `--fail-on block` 종료 4, 모르는 field가 있는 Decision은 review 종료 1(verdict 없음, `PROJECT_TRUTH_INVALID`)·doctor 6·MCP `isError`, Truth 불변

## 0.2.1 (H-65, C242, 2026-10-04 release, `v0.2.1` = `1316bdf`)

Packaging patch([release notes](notes-0.2.1.md), [호환성 분류](compatibility.md#021-변경-분류-t324-h-65)). npm 12와 local tarball 설치가 package 안의 `npm-shrinkwrap.json`을 따르지 않아 0.2.0의 release-locked tree가 깨졌다(C242, 공개 0.2.0 영향 B). runtime code, 공개 형식, Truth, 명령은 0.2.0과 같다. 다른 변경은 넣지 않는다(C229·C239·C240·C241, package description, `--help` 첫 줄, README 재설계는 범위 밖).

- [x] PoC(임시 사본): `bundleDependencies` B1(`true`)·B2(직접 의존성 12개 목록) 모두 tarball에 67 package(transitive 포함, 중첩 0, symlink 0), 서로 다른 두 `npm ci` 결과로 다시 pack해도 integrity 동일, npm 10.9.9/11.21.0/12.2.0 global·project-local 설치 트리 = lock
- [x] 대안 비교: A exact pin(mitigation), C esbuild bundle(typescript external·WASM vendoring 필요, runtime 형태 변경), D custom vendoring(기각). H-65 (6)
- [x] regression test(mechanism 비종속): 설치 트리 = artifact가 기록한 트리(`dist/runtime-tree.json`), global·project-local, package 밖 설치 0
- [x] pack: release lock → 격리 `npm ci` → `bundleDependencies` + `dist/runtime-tree.json`, bundled package 67개의 notices(license 원문). preflight(runtime tree = lock, `node_modules/` allowlist = 기록한 package, notices, audit), conformance, verify-published, audit(source·artifact)
- [x] Contract #15 문구(invariant 유지, mechanism은 검증 열)
- [x] version 0.2.0 → 0.2.1: `apps/cli/package.json`, release lock의 package version 두 곳(의존성 트리 불변), README·07의 현재 version 예시
- [x] upgrade journey(`pnpm release:upgrade`, 공개 0.2.0 → RC): TypeScript·Python·C++·sparse 저장소 모두 0.2.0 index가 RC에서 current, 다음 index는 parse 0·Graph 쓰기 없음, context ready, codex·claude-code install verify 성공, Truth byte 불변, re-init·migration 신호 0
- [x] RC tarball 설치 matrix(Windows, Node 24.18.0): npm 10.9.9/11.21.0/12.2.0 × global·project-local(`npx --no-install duoctl` 포함) 6칸 모두 설치 트리 = `dist/runtime-tree.json`(불일치·추가·package 밖 설치 0, bundled 파일 7,443개 내용 동일), install script 0, `duoctl 0.2.1`, init·status·doctor·context·MCP(tool 9개) 성공
- [x] CI 3 OS(run 37162699650, `dabfe45`): pnpm test, grammar, 배포 E2E, conformance success. 로컬: `pnpm verify`(1,008 pass / 7 skip), `test:dist` 21/21, `test:conformance`(suite 95/0, C209 20/0), `release:audit`(advisory 0, artifact = lock)
- [x] RC commit `1316bdf`의 full CI(3 OS, run 37178168821)
- [x] `pnpm release:preflight` READY(codeReady·externalReady true, blocker 0), `npm publish --dry-run`(7,468 entries, 목록 = release candidate, bundled 67)
- [x] npm publish(검증한 RC tarball 그대로, 브라우저 2FA 승인 1회, integrity `sha512-E34DdTXz…FEVhQ==`, shasum `5c344564efcccbe2a59333b0557eeee67bfd1f4f`), registry version·integrity·shasum·fileCount = RC, `latest` = 0.2.1
- [x] registry 설치 검증(Windows, Node 24.18.0): npm 12.2.0·11.21.0·10.9.9 × global·project-local(`npx --no-install duoctl` 포함) 6칸 모두 `duoctl 0.2.1`, 설치 트리 = `dist/runtime-tree.json`(67 package, 경로·version·내용 불일치 0, package 밖 설치 0), install script 0, init·status·doctor·context·MCP 성공
- [x] annotated tag `v0.2.1` → `1316bdf`, GitHub Release "DUO 0.2.1"(draft·prerelease 아님, 본문 = release notes, 상대 링크만 `v0.2.1` 기준 절대 링크로)
- [x] `pnpm release:verify-published` OK(problems 0: registry integrity = RC, 빈 npm 설정 설치, 설치 트리 = runtime tree, 실행, tag commit, GitHub Release)


## 0.2.0 (H-62, 2026-10-03 release, `v0.2.0` = `90a506b`)

Minor release: L1 correctness, freshness 최적화, doctor·onboarding, ambiguity 안내, OpenAI-compatible provider([release notes](notes-0.2.0.md), [호환성 분류](compatibility.md#020-변경-분류-t28-h-62)). 공개 형식은 additive 추가만 있고 0.1.x Truth·project.yaml은 그대로 유효하다. T28에서는 release blocker·regression·packaging 수정만 허용했다.

- [x] version 0.1.2 → 0.2.0: `apps/cli/package.json`, `apps/cli/npm-shrinkwrap.json`의 package version 두 곳(의존성 트리 불변), README·07의 현재 version 예시
- [x] upgrade journey(`pnpm release:upgrade`, preflight `upgrade` blocker): 공개 0.1.2 → RC, stale → index 한 번 → current, Truth byte 불변
- [x] release notes, compatibility, product contract(#17 OpenAI-Compatible Provider, #18 upgrade), SECURITY 지원 version(0.2.x)
- [x] full CI(3 OS, run 37112325018), real-world workflow(3 OS, run 37112331406), `pnpm release:preflight` READY(blocker 0), `npm publish --dry-run`(목록 = release candidate)
- [x] npm publish(검증한 RC tarball 그대로, integrity `sha512-CFqbBpfx…SwOmJrdcA==`, shasum `4b9ae403abce5cf8f6af1ce6e595ed87145762f1`), registry version·integrity·shasum = RC, `latest` = 0.2.0
- [x] registry에서 global install, `duoctl --version` = 0.2.0, 새 Git 저장소에서 init·status·doctor
- [x] annotated tag `v0.2.0` → `90a506b`, GitHub Release "DUO 0.2.0"(draft·prerelease 아님, 본문 = release notes, 상대 링크만 `v0.2.0` 기준 절대 링크로)
- [x] `pnpm release:verify-published` OK(registry, 빈 npm 설정 설치, 실행, tag commit, GitHub Release)

실제 외부 OpenAI-compatible endpoint smoke(`pnpm test:compatible-smoke`)와 실제 OpenAI smoke는 선택 검증이며 0.2.0 release gate가 아니다(NOT RUN · optional external smoke).

## 0.1.2 (H-47, 2026-09-30 release, `v0.1.2` = `93010a4`)

Security patch: LLM provider 요청의 secret redaction([release notes](notes-0.1.2.md)). 공개 형식, 명령 의미, exit code, Truth 형식, 결정적 Review는 0.1.1과 같다. 다른 기능 변경은 넣지 않는다.

준비 항목:

- [x] version 0.1.1 → 0.1.2: `apps/cli/package.json`, `apps/cli/npm-shrinkwrap.json`의 package version 두 곳(의존성 트리 불변)
- [x] regression test: `packages/director/src/llm/llm.test.ts`(provider 경계), `packages/integration/src/llm/semantic.e2e.test.ts`(shared review operation, MCP, Context와 같은 정책, 결정적 결과, echo 응답과 오류, 기록된 파일)
- [x] full CI(3 OS) at `93010a4`: run 36669896094 success

최종 상태(2026-10-03 확인, T30): npm `@duo-director/cli@0.1.2` 게시, `v0.1.2` → `93010a4`, GitHub Release 게시(2026-09-30). 2026-10-03에 `pnpm release:verify-published --version 0.1.2 --commit 93010a4…`로 다시 확인했다: OK(registry, 빈 npm 설정 설치, `duoctl 0.1.2`, init·status, tag commit, GitHub Release). 당시 release candidate의 integrity 기록이 없어 registry integrity(`sha512-vFDkYOMx…4AUbCw==`)를 RC와 비교하지는 않았다. 그 release candidate의 `pnpm release:preflight` READY와 `npm publish --dry-run` 결과는 남아 있지 않아 완료로 표시하지 않는다.

## 0.1.1 (H-46, 2026-09-30 release)

Patch release: 사람용 CLI 안내 3개, 테스트, release tooling, 문서([release notes](notes-0.1.1.md)). 공개 형식, 명령 의미, exit code, Truth 형식은 0.1.0과 같다. 성능 후보와 새 기능은 넣지 않는다([0.1.1 hardening](../roadmap/0.1.1-hardening.md)).

준비 항목:

- [x] version 0.1.0 → 0.1.1: `apps/cli/package.json`, `apps/cli/npm-shrinkwrap.json`의 package version 두 곳. 의존성 트리는 바꾸지 않았다(`release:lock`을 다시 실행하지 않음)
- [x] 안내 문구 regression test(`tests/cli/first-run.e2e.test.ts`, 설치본 conformance에도 포함), `--json` 출력이 0.1.0과 byte 단위로 같음
- [x] 배포 E2E의 npx 음성 검사를 개발 PC의 global 설치와 분리(C215)
- [x] full CI(3 OS) at `834bc6f`: run 36660964359 success
- [x] `pnpm release:preflight` READY at `834bc6f`(blocker 0, 마지막 단계 `npm publish --dry-run` 포함; maintainer release 기록 2026-09-30). RC integrity `sha512-UJ+AIh9a…5zgmQ==`

최종 상태(2026-10-03 확인, T30): npm `@duo-director/cli@0.1.1` 게시, `v0.1.1` → `834bc6f`, GitHub Release 게시(2026-09-30). 2026-10-03에 `pnpm release:verify-published --version 0.1.1 --integrity <RC integrity> --commit 834bc6f…`로 다시 확인했다: OK(registry integrity = RC, 빈 npm 설정 설치, `duoctl 0.1.1`, init·status, tag commit, GitHub Release).

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

순서(0.1.x와 같은 흐름, publish가 먼저이고 tag는 registry 확인 뒤):

```bash
pnpm release:preflight          # READY, blocker 0 (release candidate commit에서)
npm publish .dist/duo-director-cli-0.2.1.tgz --access public --registry https://registry.npmjs.org/
npm view @duo-director/cli@0.2.1 version dist.integrity --registry https://registry.npmjs.org/   # 전파 확인, integrity = RC
npm install -g @duo-director/cli@0.2.1 && duoctl --version                                         # clean global install
git tag -a v0.2.1 -m "DUO 0.2.1" <release candidate commit> && git push origin v0.2.1
# GitHub Release v0.2.1 (본문: docs/release/notes-0.2.1.md)
pnpm release:verify-published   # --version 0.2.1 --integrity <RC integrity> --commit <RC commit>
```

0.1.0은 `v0.1.0`(`04bab58`), 0.1.1은 `v0.1.1`(`834bc6f`), 0.1.2는 `v0.1.2`(`93010a4`), 0.2.0은 `v0.2.0`(`90a506b`), 0.2.1은 `v0.2.1`(`1316bdf`)로 게시했다.

README와 package README는 publish 전에 이미 npm registry 설치 흐름으로 바뀌어 있고, 그 문서 전환 commit이 final release candidate다. publish 뒤 문서를 다시 바꿀 필요는 없다. GitHub Release는 tag를 push한 뒤 따로 만든다.

publish 전후 검증은 짝을 이룬다. publish 전에는 `pnpm release:preflight`(READY, blocker 0), publish·tag push·GitHub Release 뒤에는 `pnpm release:verify-published`(ok)를 실행한다. 0.1.0은 2026-09-30에 이 스크립트로 다시 확인했다: registry integrity가 RC와 같고, 설치된 `duoctl 0.1.0`이 새 저장소에서 init·status를 마쳤으며(index current, LLM disabled), `v0.1.0`은 `04bab58`, GitHub Release는 게시 상태다.

## 알려진 limitation

- Windows에서 설치 직후 첫 명령이 오래 걸릴 수 있다(기준 환경 17~19 s, 이후 1.4~1.5 s). 새로 설치된 JavaScript 파일의 첫 open 비용이며 DUO 작업과 무관하다([performance-benchmark](../performance-benchmark.md#설치-직후-첫-실행-release-hardening)).
- runtime dependency 트리를 package에 고정해 싣으므로(H-65) transitive dependency의 보안 수정은 새 DUO release 전까지 반영되지 않는다(C163). bundled package도 사용자 프로젝트의 `npm audit` 집계에 포함된다(npm 11 관찰).
