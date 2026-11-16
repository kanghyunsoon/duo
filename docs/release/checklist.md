# Release checklist

`pnpm release:preflight`가 아래 항목을 검사하고 `.dist/release-preflight.json`(`duo.release-preflight/1`)에 blocker를 기록한다. preflight는 version을 바꾸거나 commit·tag·npm scope 생성·publish를 하지 않는다. 마지막 npm 단계는 `npm publish --dry-run`이다.

## 명령

MCP Registry 메타데이터(`server.json`, `mcpName`)와 등록 절차: [mcp-registry.md](mcp-registry.md). Version을 올릴 때 `server.json`도 함께 고친다. Registry 등록은 별도 승인이다.

| 명령 | 내용 | network |
|---|---|---|
| `pnpm release:lock` | build-time release lock `apps/cli/npm-shrinkwrap.json` 재생성(의존성·version 변경 시, H-65). 기존 lock을 seed로 써서 바뀌어야 하는 항목만 다시 고른다. diff를 검토해 커밋 | 필요 |
| `pnpm release:pack` | clean tree 확인 → build → pack(release lock을 격리 `npm ci`로 설치해 `node_modules/`에 bundle, `dist/runtime-tree.json`) → `.dist/release-candidate.json`(`duo.release-candidate/2`: commit, branch, clean, version, hash, runtime tree). dirty면 거부(`DUO_RELEASE_ALLOW_DIRTY=1`은 시험용) | 필요(release lock 설치, npm cache가 있으면 cache) |
| `pnpm release:audit` | source: release lock의 npm advisory와 deprecated 검사. artifact: pack한 runtime tree(`dist/runtime-tree.json`)가 그 lock과 같은 package(경로·version·integrity)인지 → `.dist/release-audit.json`(`duo.release-audit/2`) | 필요 |
| `pnpm release:preflight` | git·release channel(H-70: version에 SemVer prerelease가 없으면 branch main·origin/main·dist-tag latest, 있으면 branch next·origin/next·dist-tag next, 다른 branch는 blocker, override 없음, report `channel`)·CI → verify, grammar, benchmark smoke, 배포 E2E → release:pack → 재현성 → metadata·allowlist·secret·절대경로 → dependency·license → npm identity·registry·scope·version → `npm publish --dry-run` → OpenAI smoke 결과(선택 검증, blocker 아님). 검증 단계에 `release:upgrade`가 포함된다 | 필요 |
| `pnpm release:upgrade` | upgrade journey(T28): registry의 이전 version(기본 0.2.0)과 RC를 격리 prefix 두 곳에 설치 → 이전 version이 TypeScript·Python·C++·sparse 저장소를 도입(0.1.x project.yaml 변형 A~E, Codex 연결) → RC 설치본으로 `--version`·status·doctor·index·status(current)·context·review·install verify. 이전 index가 stale·incompatible이면 index 한 번으로 current, current로 보고되면 다음 index가 parse 0·Graph 쓰기 없음이어야 한다 → Truth byte·baseline·re-init·migration 확인 → `.dist/release-upgrade.json`. preflight가 이 commit·RC의 성공 결과를 요구한다 | 필요(이전 version 설치) |
| `pnpm test:openai-smoke` | 선택: 실제 OpenAI Responses 호출(공식 `api.openai.com`, `DUO_OPENAI_SMOKE=1`, `OPENAI_API_KEY`, `DUO_OPENAI_SMOKE_MODEL`). `.dist/openai-smoke.json`에 commit, model, 확인 항목만 기록 | 필요 |
| `pnpm test:conformance` | RC를 격리 prefix에 설치 → runtime tree(설치 트리 = `dist/runtime-tree.json`, package 밖 설치 0)·notices → C209 init 반복(`DUO_C209_RUNS`, 기본 20) → 설치된 duoctl로 CLI·MCP·install journey와 RC 전용 검사 → 문서·help 대조 → `.dist/release-conformance.json` | 필요(npm install) |
| `pnpm release:verify-published` | publish **뒤** 확인(T21): registry의 name·version·integrity·license·engines·bin → 빈 npm 설정과 새 cache로 임시 prefix에 `npm install -g` → 설치된 파일 수(bundled `node_modules/` 포함, npm이 만든 `.bin` 제외)·LICENSE·runtime tree(0.2.1부터 설치 트리 = `dist/runtime-tree.json`, 그 전 version은 `npm-shrinkwrap.json` 존재) → PATH의 `duoctl --version`·`--version --json`·`--help` → 새 Git 저장소에서 `init`→`status` → origin의 `v<version>` tag commit → GitHub Release(draft 아님) → release channel(stable: dist-tag latest = version, GitHub Release prerelease 아님; prerelease: dist-tag next = version, latest는 stable version 그대로, GitHub Release prerelease) → `.dist/release-published.json`. 기대 integrity와 commit은 `--integrity`·`--commit` 또는 같은 version의 `.dist/release-candidate.json`. publish·tag·login을 하지 않고 npm credential을 읽지 않는다. CI와 `pnpm verify`에는 넣지 않는다 | 필요 |
| `pnpm release:authorization` | publish **직전** 확인(H-81, T63; T60 사고 재발 방지): `.dist/release-candidate.json`의 version·commit에 대해 Human Decision 행(`docs/conflicts.md`의 H-n 행)이 전체 commit SHA와 정확한 version(0.3.0은 0.3.0-rc.6과 다름)을 담는지, `docs/release/checklist.md`에 그 version을 제목에 담고 commit(7자 이상)을 적은 절이 있는지, 두 파일에 program source처럼 보이는 줄(JavaScript처럼 시작하는 줄, fs require)이 없는지, 후보 commit 뒤로 `docs/` 밖이 바뀌지 않았는지 확인 → `.dist/release-authorization.json`. 기록은 working tree가 아니라 Git ref에서 읽는다: stable은 push된 `HEAD`(main), prerelease는 `origin/main`. 그래서 checklist의 해당 version 절(후보 SHA 포함)은 publish 전에 먼저 쓰고, publish 뒤 결과를 채운다 | 없음(Git만) |

## 0.3.3 (H-87, 2026-10-15 stable release, dist-tag `latest`, `v0.3.3` = `e4abe6a`)

Stable UX patch on branch `main`(H-87): #14(검사하지 않는 constraint 표시, PR #18), #8(MCP 시작 지연 적재와 bridge 재확인 안내, PR #19), #15(init answers 오류, PR #20), #16(review의 정확한 위반 줄, PR #21), #3(a)(Codex trust·Claude Code 승인 안내, PR #22)만 담는다. version commit을 PR로 검토한 뒤 `next`와 `main`을 같은 commit으로 fast-forward한다. 새 규칙·검사 없음, dependency·schema·migration 변경 없음. External Validation 01은 정확히 0.2.1이다. H-87 exact target `e4abe6afad061a6ab8f23e3ae0ae32118521de24`. [release notes](https://github.com/kanghyunsoon/duo/blob/main/docs/release/notes-0.3.3.md)

- [x] 제품 delta(`v0.3.2` 대비 `apps/`·`packages/`)가 H-87 목록과 같다(test 제외 22 files). dependency 변경 없음. MCP tool 9개(이름·schema·annotation이 0.3.2와 byte 동일), `CONTEXT_POLICY_VERSION` 8, Truth schema·lock 형식·공개 `/1` 형식 그대로
- [x] version 0.3.3(`e4abe6a`, PR #23), release lock(diff는 version 2줄, 67 packages, runtime tree `264ab643…`로 0.3.2와 같음), release notes, compatibility 0.3.3 절
- [x] CI 3 OS: PR #23(Windows 배포 E2E 1차 실패: project-local `npm install -D`가 spawn 600초 제한 초과, 같은 commit 재실행 success, 로컬 22/22), `next` run 38661153789, `main` run 38664707979 success
- [x] tarball `duo-director-cli-0.3.3.tgz` 24,379,674 B, 7,468 files, bundled 67, sha1 `638e5fa5ad89e950b83937135aed2cf669af789b`, sha256 `436b7896147f0c7f7ff76a25e51cb38630fc1397db3ee9055031ef3ae6fd629c`, integrity `sha512-vnF+OgdH0ocyRgAH7ZzL/EBmYG8JmZnXDhm9deHA1Y8jfLemBXteMcBvbpUvlczN463fwM7ct6/+X7UhNgrDbw==`. release pack, 독립 pack, preflight 재pack 2회 모두 byte 동일
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel stable, branch main, upstream origin/main, dry-run tag latest, npm scope owner, 0.3.3 미게시): verify, grammar, benchmark smoke, 배포 E2E, conformance(98/0, C209 20/0), upgrade(0.2.0 → 0.3.3), audit(advisory 0), secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC. 첫 실행은 npm 인증 만료로 BLOCKED(externalReady false), 재로그인 뒤 같은 commit에서 READY
- [x] upgrade 0.3.2 → 0.3.3(ts, python, cpp, sparse: Truth 불변, re-init 없음)
- [x] 설치 matrix(npm 10/11/12 global, npm 11 local): runtime tree(67, mismatch 0), doctor, MCP 9, canonical BLOCK, `--fail-on block` 4, invalid Truth fail-closed. 칸별 T42·H-71/H-72(Decision Lock, proposal confirm)·C249/C251·C256·H-79·H-80·C258 16/16 ok, T45(oh45), downgrade 0.3.3 → 0.2.2 fail-closed
- [x] 공개 0.3.2와 비교: Decision Compliance·Knowledge Gap fixture의 review JSON·종료 코드·context packet·gap 같음. 사람 review 출력은 CONFLICT 아래 `observed:` 줄 추가만(#16). 같은 금지 import 변경에서 verdict·claim·evidence 같고 limitation `constraints-unscoped`와 status `truth.unscopedConstraints`만 추가(#14)
- [x] #8: MCP initialize 중앙값(Windows, Node 24.18, 19-file 저장소, T77) 단독 0.3.2 1.61–1.73초 → 0.72–0.83초, 8개 동시 1.93–2.00초 → 0.99–1.03초. 0.3.2 bridge는 `outdated`, `install`이 사람 확인 뒤 block만 갱신. 실제 Codex MCP 발견률은 NOT TESTED(#8 Open)
- [x] H-87 기록(target `e4abe6a`)
- [x] `pnpm release:authorization` OK(H-87, record HEAD `8b91b7f`, 후보 뒤 변경은 `docs/`만). 그 commit의 `main` CI(run 38680385920) 3 OS success 뒤 publish
- [x] npm publish `@duo-director/cli@0.3.3` `--tag latest --access public`(검증한 tarball 그대로, 사람이 자기 terminal에서 2FA와 함께 실행, 04:47:39 UTC). registry metadata는 바로 보였지만 tarball URL은 약 6분 동안 404였다(재게시하지 않고 기다림). shasum `638e5fa5…`·integrity·fileCount 7,468·unpacked 114,203,857 B = RC, registry tarball sha256 `436b7896…629c` = RC, `latest` = 0.3.3, `next` = 0.3.0-rc.6 그대로
- [x] annotated tag `v0.3.3` → `e4abe6a`, GitHub Release "DUO 0.3.3"(draft 아님, prerelease 아님, GitHub latest release = v0.3.3, tarball 첨부, asset sha256 = RC)
- [x] `pnpm release:verify-published` OK(problems 0, channel stable, dist-tags latest 0.3.3·next 0.3.0-rc.6, tag commit = H-87 target, 설치 파일 7,468·runtime tree 67). 첫 실행은 tarball 404 동안이라 install 실패, 반영 뒤 OK
- [x] registry 설치(`@duo-director/cli@0.3.3`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.3`, runtime tree(67, mismatch 0), doctor, MCP 9, canonical BLOCK, `--fail-on block` 4, invalid Truth fail-closed. 칸별 추가 회귀 16/16 ok, T45, downgrade 0.3.3 → 0.2.2 fail-closed, 공개 0.3.2와 사람 review 출력 차이는 `observed:` 줄 추가만
- [x] 공개 설치본으로 #14(init 안내, status·doctor의 미검사 constraint, review limitation `constraints-unscoped`), #15(잘못된 answer → `INIT_ANSWER_INVALID`, 쓰기 0), #16(`observed: … src/ui/page.js:3 …`) 확인. 실제 Codex MCP 발견률은 NOT TESTED(#8 Open)
- [x] Issue #14·#15·#16 close. #8·#3·#4·#5·#7 Open 유지

## 0.3.2 (H-86, 2026-10-13 stable release, dist-tag `latest`, `v0.3.2` = `c612993`)

Stable UX patch on branch `main`(H-84, H-85, H-86): #6(`install remove`가 DUO가 만든 MCP 설정 파일을 지움, PR #9)과 #8(Agent bridge 안내, PR #10)만 담는다. H-86 exact target `c612993f080b1d68c991370d5ba1344adbbe3c09`. version commit을 PR #12로 검토한 뒤 `next`와 `main`을 같은 commit으로 fast-forward했다. 새 기능 없음, dependency·schema·migration 변경 없음. External Validation 01은 정확히 0.2.1이다. [release notes](https://github.com/kanghyunsoon/duo/blob/main/docs/release/notes-0.3.2.md)

- [x] 제품 delta(`v0.3.1` 대비 `apps/`·`packages/`): `packages/integration/src/agents/integration.ts`(#6), `packages/integration/src/agents/bridge.ts`(#8). 나머지는 test·문서·version. MCP tool 9개, `CONTEXT_POLICY_VERSION` 8, Truth schema·lock 형식·공개 `/1` 형식 그대로
- [x] version 0.3.2(`c612993`), release lock(diff는 version 2줄, 67 packages, runtime tree `264ab643…`로 0.3.1과 같음), release notes, compatibility 0.3.2 절
- [x] tarball `duo-director-cli-0.3.2.tgz` 24,378,255 B, 7,468 files, bundled 67, sha1 `23f264900ac11dbcb888484111fd5a36866b7da2`, sha256 `d0f0f22923b329770520063e14d7be97f51304ff3c89965066c620658cdb050c`, integrity `sha512-1/EF8FUeaLkwBipR+1/zJdo9cSlV8ii25lI6urNuI2OLxDKYbCrXn7W4WUodWa2ovESfAaSiDPfjD6VPVrqzsw==`. release pack, 독립 pack, preflight 재pack 모두 byte 동일
- [x] CI 3 OS(PR #12, 후보 run 38326026797) success
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel stable, branch main, upstream origin/main, dry-run tag latest): verify, grammar, benchmark smoke, 배포 E2E, conformance(98/0, C209 20/0), upgrade, audit(advisory 0, deprecated 0, artifact = lock), secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC
- [x] upgrade 0.2.2 → 0.3.2, 0.3.1 → 0.3.2(Truth 불변, re-init 없음)
- [x] 설치 matrix(npm 10/11/12 global, npm 11 local): runtime tree(67, mismatch 0, package 밖 설치 0), doctor, MCP 9, canonical BLOCK, `--fail-on block` 4, invalid Truth fail-closed, 칸별 T42·C249/C251·C256·H-79·H-80·C258. C261~C265·H-80 16개 사례가 공개 0.3.1과 같고 네 칸이 같다. packed e2e 20/20, T45, downgrade 0.3.2 → 0.2.2 fail-closed
- [x] #6(설치본): DUO가 만든 `.codex/config.toml`·`.mcp.json`은 plan = apply = delete, backup 보존, status `not-configured`, 두 번째 remove no-op. 기존 Codex TOML·AGENTS.md·CLAUDE.md는 byte 동일, 기존 `.mcp.json`은 값 동일(서식은 재직렬화, 기존 동작)
- [x] #8(설치본): 새 block 8줄(탐색·CLI fallback·proposal 없음 안내), 0.3.1 block은 `drifted · bridge outdated` → `install codex`가 block만 갱신, npx launcher 문구
- [x] 정상 저장소: OpenHub와 DUO에서 status·review·context가 공개 0.3.1과 같다. doctor는 버전 표기와, 0.3.1 bridge가 설치된 OpenHub에서 `drifted`(bridge outdated, #8 의도) 표시만 다르다
- [x] H-86 기록(target `c612993`)
- [x] `pnpm release:authorization` OK(record HEAD `9abc539` = origin/main, H-86, problems 0)
- [x] npm publish `@duo-director/cli@0.3.2` `--tag latest --access public`(검증한 tarball 그대로). Agent 세션의 web 2FA 승인이 두 번 만료돼(registry 202 대기 뒤 404, publish 안 됨) 사람이 자기 terminal에서 같은 tarball로 실행했다. registry가 새 version을 보이기까지 publish 뒤 수십 분 걸렸다(확인 03:21 UTC). shasum `23f26490…`·integrity·fileCount(7,468)·unpacked 114,195,112 B = RC, `latest` = 0.3.2, `next` = 0.3.0-rc.6 그대로
- [x] annotated tag `v0.3.2` → `c612993`, GitHub Release "DUO 0.3.2"(draft 아님, prerelease 아님, GitHub latest release = v0.3.2, tarball 첨부)
- [x] `pnpm release:verify-published` OK(problems 0, channel stable, dist-tags latest 0.3.2·next 0.3.0-rc.6, tag commit = H-86 target, 설치 파일 7,468·runtime tree 67)
- [x] registry 설치(`@duo-director/cli@latest`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.2`, runtime tree(67), doctor, MCP 9, 칸별 추가 회귀, C261~C265·H-80 16개 사례가 공개 0.3.1과 같음(네 칸 동일), #6 remove·#8 bridge 갱신이 publish 전과 같음, 공개 0.3.1과 출력 동일, T45
- [x] Issue #6 close, `next` → `main` fast-forward

## 0.3.1 (H-83, 2026-10-12 stable release, dist-tag `latest`, `v0.3.1` = `cce2d3d`)

Stable correctness patch on branch `main`(H-82, H-83): C261~C265만 고친다. H-83 exact target `cce2d3d6a8d8f559155aed19ca7da3b1e5dfabb5`. `next`(T65~T67, H-83 기록)를 `main`에 fast-forward한 뒤 version commit을 만들었다. 새 기능 없음, migration 없음. External Validation 01은 정확히 0.2.1이다. [release notes](https://github.com/kanghyunsoon/duo/blob/main/docs/release/notes-0.3.1.md)

- [x] 제품 delta(`v0.3.0` 대비 `apps/`·`packages/`): core `decisions/integrity.ts`(신규)·`diagnostics.ts`·`domain/definitions.ts`·`index.ts`·`loader/authority.ts`·`loader/project.ts`, director `review/rules.ts`·`review/review.ts`·`review/snapshot.ts`(신규), CLI `messages.ts`(문구). 나머지는 test. `CONTEXT_POLICY_VERSION` 8, Truth schema·lock 형식·공개 `/1` 형식 그대로
- [x] version 0.3.1(`cce2d3d`), release lock(diff는 version 2줄, 67 packages, dependency 변경 없음), release notes, compatibility 0.3.1 절, SECURITY.md 지원 line 0.3.x
- [x] tarball `duo-director-cli-0.3.1.tgz` 24,378,319 B, 7,468 files, bundled 67, sha1 `ea5617f98d634aa6f6f5c921bab1cfdfbb6df4dc`, sha256 `b74e6692b8f620d1b12f3801cf640281a49c8ec88ee71cb9eb3776026ad8bc27`, integrity `sha512-aYFK2XFl86tMzOiMAbyp07nhf1FwrWQTaZz0dutTthJtMt2L6MXeDcHxIM5eRcMEo1Slc7b1L/9aSmHJ9KT8+Q==`, runtime tree `264ab643bb960f509d537f4097c56120b4f368123fe729fd5d1b330d64d09251`. preflight 재pack과 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 38186910407) success
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel stable, branch main, upstream origin/main, dry-run tag latest): verify, grammar, benchmark smoke, 배포 E2E, conformance(97/0, C209 20/0), upgrade, audit(advisory 0, deprecated 0, artifact = lock), secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC. 첫 실행은 verify 안의 `tests/ui/ui.browser.e2e.test.ts` beforeAll hook이 전체 suite 부하에서 300초 timeout으로 실패해 BLOCKED였다(단독 실행 3개 통과, 44초). 코드 변경 없이 다시 실행해 READY
- [x] 설치본(npm 10/11/12 global, npm 11 local)으로 registry 0.3.0과 나란히 C261(잘못된 `superseded_by`, confirmed → rejected·proposed: 0.3.0 PASS·WARN → verdict 없이 1, 범위 안 retire는 `confirmed-decision-retired` BLOCK), C262(enforcement·forbids 변경 commit 뒤: verdict 없이 1, status `truth.errors`, doctor 6), C263(`type: Decision`, type 없음: `DECISION_SOURCE_INVALID`, README·`.yaml.txt`·메모는 그대로 BLOCK), C264(staged code 불일치 `REVIEW_SNAPSHOT_MISMATCH`, staged Truth 불일치 fail closed, 깨끗한 staged와 commit 범위는 BLOCK), C265(파일 5,000개: `REVIEW_ANALYSIS_INCOMPLETE` + `CONTEXT_REQUEST_INVALID`, `--fail-on ask` 1, Record 없음, 파일 1개는 ASK), H-80(missing-intent만: PASS, gap 표시, warn basis 비어 있음). 네 칸 결과 동일
- [x] 설치 matrix: runtime tree(67, mismatch 0, package 밖 설치 0), doctor, MCP 9, canonical BLOCK, `--fail-on block` 4, invalid Truth fail-closed, 칸별 T42·C249/C251·C256·H-79·H-80·C258. 공개 0.3.0과 review(PASS·ASK·BLOCK·WARN)·Context Packet·gap 출력 동일, packed e2e(decision-authority, rc-blockers, missing-intent, review-completeness), T45(TASK-015 → D-004·D-005)
- [x] 정상 저장소: OpenHub와 DUO에서 status·review(3·2 변형)·context가 공개 0.3.0과 byte 동일, doctor는 버전 표기만 다름. upgrade 0.2.2 → 0.3.1·0.3.0 → 0.3.1(Truth 불변, re-init 없음, 0.3.0 index 그대로 current), downgrade 0.3.1 → 0.2.2 fail-closed
- [x] H-83 기록(main `90515c7`, target `cce2d3d`)
- [x] `pnpm release:authorization` OK(record HEAD `90515c7` = origin/main, H-83, problems 0)
- [x] npm publish `@duo-director/cli@0.3.1` `--tag latest --access public`(검증한 tarball 그대로, 2FA 승인). registry가 새 version을 보이기까지 약 30분 걸렸다(publish 시각 03:24 UTC). integrity·shasum·fileCount(7,468)·unpacked 114,194,492 B = RC, `latest` = 0.3.1, `next` = 0.3.0-rc.6 그대로
- [x] registry 설치(`@duo-director/cli@latest`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.1`, runtime tree(67, mismatch 0, extra 0, package 밖 설치 0), doctor, MCP 9, canonical BLOCK, `--fail-on block` 4, invalid Truth fail-closed, 칸별 T42·C249/C251·C256·H-79·H-80·C258, C261~C265·H-80 회귀(publish 전과 같은 결과), 공개 0.3.0과 review·Context Packet·gap 출력 동일, T45(TASK-015 → D-004·D-005; TEMP 정리로 지워진 fixture를 TEMP 밖 사본으로 바꿔 다시 실행)
- [x] annotated tag `v0.3.1` → `cce2d3d`, GitHub Release "DUO 0.3.1"(draft 아님, prerelease 아님, GitHub latest release = v0.3.1, tarball 첨부)
- [x] `pnpm release:verify-published` OK(problems 0, channel stable, dist-tags latest 0.3.1·next 0.3.0-rc.6, tag commit = H-83 target)

## 0.3.0 (H-81, 2026-10-11 stable release, dist-tag `latest`, `v0.3.0` = `98267fa`)

Stable release on branch `main`: 0.3.0-rc.6의 제품 semantics를 바꾸지 않고 승격한다(H-81). H-81 exact target `98267fac70a64a9fd618397b97a0f7e2d2009099`. `next`를 `main`에 merge(`4475283`)했고 제품 tree는 rc.6(`d0f29a5`)과 같다. C259는 known limitation이다. External Validation 01은 정확히 0.2.1이다. [release notes](https://github.com/kanghyunsoon/duo/blob/main/docs/release/notes-0.3.0.md)

- [x] release guard `pnpm release:authorization`(`44a8509`, T60 사고 재발 방지): rc.6 기록(main `2c3952f`)은 통과하고 사고 commit의 기록은 막힘
- [x] merge `4475283`: 제품 tree(`apps/`·`packages/`)는 `d0f29a5`와 diff 0, 문서 충돌은 양쪽 내용을 합침, main 전용 0.2.2 test `tests/cli/truth-fail-closed.e2e.test.ts` 제거
- [x] version 0.3.0(`98267fa`), release lock(diff는 version 2줄, 67 packages), release notes, compatibility 0.3.0 절
- [x] tarball `duo-director-cli-0.3.0.tgz` 24,378,205 B(unpacked 114,186,212 B), 7,468 files, bundled 67, sha1 `f8eab974800263f59da3ae179fbaccda901791c6`, sha256 `a990ce5450414e61a1751ce20e37a8af5bf8c679625e74db7747b3c318b6c76c`, integrity `sha512-6dSHDzjhXyVBn6gpqECkbiZP/hp5IM1AMiFCnIZ2JY1WsKzlh665zdRSrII1p/ee8bWtMyNPiT17XC/AvnkggQ==`, runtime tree `264ab643bb960f509d537f4097c56120b4f368123fe729fd5d1b330d64d09251`. rc.6 tarball 대비 차이는 `package.json` version과 `dist/runtime-tree.json`의 package 이름·lock hash뿐. preflight 재pack과 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 38111951690) success
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel stable, branch main = main, upstream origin/main, dry-run tag latest): verify, grammar, benchmark smoke, 배포 E2E, conformance, upgrade, audit, secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC. 첫 실행은 verify 안의 `packages/integration/src/llm/compatible/provider.test.ts` 한 test가 전체 suite 부하에서 5,000 ms timeout으로 실패해 BLOCKED였다(단독 재실행 통과). 코드 변경 없이 다시 실행해 READY
- [x] upgrade 0.2.2 → 0.3.0(TypeScript·Python·C++·sparse 저장소, Truth 불변), 설치 matrix npm 10/11/12 global과 npm 11 local(runtime tree, package 밖 설치 0, doctor, MCP 9, BLOCK, `--fail-on block` 4, invalid Truth fail-closed), 칸별 rc.3~rc.6 검사(T42, C249/C251, C256, H-79, H-80·C258), 공개 rc.6 대비 review(PASS·ASK·BLOCK·WARN의 JSON·사람 출력·종료 코드·MCP)·Context Packet·gap 출력 동일, packed e2e, T45(TASK-015 → D-004·D-005), T44 PTY(2개 확정, 1개 pending, non-TTY 거부), downgrade 0.3.0 → 0.2.2 fail-closed
- [x] H-81 기록(main `e3a0d65`, target `98267fa`)
- [x] `pnpm release:authorization` OK(record HEAD `e3a0d65` = origin/main, H-81, problems 0)
- [x] npm publish `@duo-director/cli@0.3.0` `--tag latest --access public`(검증한 tarball 그대로, 2FA 승인): registry integrity·shasum·fileCount(7,468)·unpacked size = RC, `latest` = 0.3.0, `next` = 0.3.0-rc.6 그대로
- [x] registry 설치(`@duo-director/cli@latest`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.0`, runtime tree(67, mismatch 0, extra 0, package 밖 설치 0), doctor, MCP 9, canonical BLOCK, `--fail-on block` 4, invalid Truth fail-closed, 칸별 T42·C249/C251·C256·H-79·H-80·C258, 공개 rc.6과 review·Context Packet·gap 출력 동일, T45(TASK-015 → D-004·D-005)
- [x] annotated tag `v0.3.0` → `98267fa`, GitHub Release "DUO 0.3.0"(draft 아님, prerelease 아님, GitHub latest release = v0.3.0, tarball 첨부)
- [x] `pnpm release:verify-published` OK(problems 0, channel stable, dist-tags latest 0.3.0·next 0.3.0-rc.6, tag commit = H-81 target)

## 0.3.0-rc.6 (H-74, 2026-10-11 prerelease, dist-tag `next`, `v0.3.0-rc.6` = `d0f29a5`)

Prerelease on branch `next`: rc.5 이후의 T58(H-80, C239: `missing-intent` gap은 surface 그대로이고 단독으로 WARN이 아님, MCP review text에 Knowledge gap 표시)과 T59(C258: missing-intent 문구 정정)를 담는다. T57은 감사 문서만이다. H-74 exact target `d0f29a51eeb71d74b9388c2436cfa09380310e03`. stable 0.3.0 승격은 하지 않았고 `next`를 `main`에 merge하지 않았다. External Validation 01은 정확히 0.2.1이다. [release notes](https://github.com/kanghyunsoon/duo/blob/next/docs/release/notes-0.3.0-rc.6.md)

- [x] version 0.3.0-rc.6, release lock(diff는 version 2줄, 67 packages), release notes(`next` `d0f29a5` = source candidate). rc.5 대비 제품 코드 변경은 `packages/director/src/review/aggregate.ts`·`gap/render.ts`·`packages/integration/src/mcp/tools.ts`뿐, `CONTEXT_POLICY_VERSION` 8 그대로
- [x] tarball `duo-director-cli-0.3.0-rc.6.tgz` 24,378,204 B(unpacked 114,186,222 B), 7,468 files, bundled 67, sha1 `743809fec165f5fb46a84afef8b1ea9767513481`, sha256 `14f19910325de57e593138dd6aff89cfe61b4b4483fd06a256b83eae887a88a2`, integrity `sha512-dD81yqtlevffZ9C9p/51lrGtA6ajJU2TY8n6uda4ee5S0rHpIMgGZPuWCiBfGkRmv0a/lyEsdNLA6PSHeGVe3Q==`, runtime tree `264ab643bb960f509d537f4097c56120b4f368123fe729fd5d1b330d64d09251`. preflight 재pack과 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 38067551969) success
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel prerelease, branch next = next, upstream origin/next, dry-run tag next): verify, grammar, benchmark smoke, 배포 E2E, conformance(97/0, C209 20/0), upgrade(0.2.0 → RC), audit high/critical 0·deprecated 0, secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC
- [x] upgrade 0.2.2 → RC(Truth 불변, sparse 저장소 review는 H-80으로 WARN → PASS), 설치 matrix npm 10/11/12 global과 npm 11 local(runtime tree, package 밖 설치 0, doctor, MCP 9, BLOCK, `--fail-on block` 4, invalid Truth fail-closed), 칸별 T42(TASK-014 7/7, TASK-010 6/6)·canonical Decision·C249/C251·C256·H-79 Context, 칸별 H-80(missing-intent만 있으면 PASS·모든 gate 0, 자연어 task PASS, BLOCK 그대로, REQ-999 ASK, 실제 WARN 2, 다른 surface gap WARN, MCP gap text, C258 문구 en·ko·context), rc.5 대비 claim·evidence·Context Packet·gap 동일(verdict, missing-intent ID가 빠진 `verdictBasis.warn`, Review Record ID만 변화, 옛 Record 불변), packed T49·N1·H-80 e2e, T45(TASK-015 → D-004·D-005), T44 PTY(2개 확정, 1개 pending, non-TTY 거부), downgrade rc.6 → 0.2.2 fail-closed(`imported_paths`, `implements.paths`; 0.2.1은 누락)
- [x] H-74 기록(main `4d3f229`, target `d0f29a5`)
- [x] npm publish `@duo-director/cli@0.3.0-rc.6` `--tag next --access public`(검증한 tarball 그대로; 첫 2FA 승인은 시간 초과로 실패해 게시되지 않았고, npm 재로그인 뒤 2FA 승인으로 게시): registry integrity·shasum·fileCount = RC, `next` = 0.3.0-rc.6, `latest` = 0.2.2 그대로, 이전 rc 공개 상태 그대로
- [x] registry 설치(`@duo-director/cli@next`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.0-rc.6`, runtime tree, package 밖 설치 0, doctor, MCP 9, canonical BLOCK, invalid Truth fail-closed, T42, C249/C251, C256, H-79, H-80·C258, T45
- [x] annotated tag `v0.3.0-rc.6` → `d0f29a5`, GitHub Release "DUO 0.3.0-rc.6"(draft 아님, prerelease true, tarball 첨부). GitHub latest release는 계속 v0.2.2
- [x] `pnpm release:verify-published` OK(problems 0, channel prerelease, dist-tags next 0.3.0-rc.6·latest 0.2.2, tag commit = H-74 target)

## 0.3.0-rc.5 (H-74, 2026-10-10 prerelease, dist-tag `next`, `v0.3.0-rc.5` = `8ed65ec`)

Prerelease on branch `next`: rc.4 이후의 T54(`.`으로 시작하는 첫 directory 경로, C256)와 T55(구분자 없는 root 파일 이름, H-79, C257)를 담고, T52(C254)·T53(C255)는 test만 바꿨다. H-74 exact target `8ed65ecc64e95d983cc290d0781d83621cd1a6b3`. stable 0.3.0 승격은 하지 않았고 `next`를 `main`에 merge하지 않았다. External Validation 01은 정확히 0.2.1이다. [release notes](https://github.com/kanghyunsoon/duo/blob/next/docs/release/notes-0.3.0-rc.5.md)

- [x] version 0.3.0-rc.5, release lock(diff는 version 2줄, 67 packages), release notes(`next` `8ed65ec` = source candidate). rc.4 대비 제품 코드 변경은 `packages/director/src/context/seeds.ts`·`policy.ts`뿐
- [x] tarball `duo-director-cli-0.3.0-rc.5.tgz` 24,378,207 B(unpacked 114,185,470 B), 7,468 files, bundled 67, sha1 `ed2369505f03a1ed3f3b762bd4dc16a8c74a6c69`, sha256 `c658850d48f2fc9e703fb1b1d05defb6b03fd49a67663522f08496ae792fded1`, integrity `sha512-EiWRvfupNO1Dl4HnMqlgK41XtFjuIV5hiZ3Zq233r5trSNw9R/SOtwf+krgUmPSbehDTnVXeX9tXVFSew3S51w==`, runtime tree `264ab643bb960f509d537f4097c56120b4f368123fe729fd5d1b330d64d09251`. preflight 재pack과 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 38039521919) success. agent-launch group(install·doctor e2e)이 3 OS 모두 메인 group 뒤에 실행됨
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel prerelease, branch next = next, upstream origin/next, dry-run tag next): verify, grammar, benchmark smoke, 배포 E2E, conformance(97/0, C209 20/0), upgrade(0.2.0 → RC), audit high/critical 0·deprecated 0, secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC. 첫 실행은 npm 로그인 만료(외부)로만 BLOCKED였고, 코드 항목은 두 번 모두 flaky 없이 통과
- [x] upgrade 0.2.2 → RC, 설치 matrix npm 10/11/12 global과 npm 11 local(runtime tree, package 밖 설치 0, MCP 9, BLOCK, `--fail-on block` 4, invalid Truth fail-closed), 칸별 T42(TASK-014 7/7, TASK-010 6/6)·canonical Decision·C249/C251 Context·C256 네 표기·H-79(root 파일 exact, `.env`·bare `LICENSE` 아님, `Session.open` Symbol, `Foo.bar` ambiguity), packed T49·N1 e2e, T45(TASK-015 → D-004·D-005), T44 PTY(2개 확정, 1개 pending, non-TTY 거부), downgrade rc.5 → 0.2.2 fail-closed(`imported_paths`, `implements.paths`; 0.2.1은 누락)
- [x] H-74 기록(main `648917b`, target `8ed65ec`)
- [x] npm publish `@duo-director/cli@0.3.0-rc.5` `--tag next --access public`(검증한 tarball 그대로, 2FA 1회): registry integrity·shasum·fileCount = RC, `next` = 0.3.0-rc.5, `latest` = 0.2.2 그대로, rc.3·rc.4 공개 상태 그대로
- [x] registry 설치(`@duo-director/cli@next`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.0-rc.5`, runtime tree, package 밖 설치 0, doctor, MCP 9, canonical BLOCK, invalid Truth fail-closed, T42, C249/C251, C256, H-79, T45
- [x] annotated tag `v0.3.0-rc.5` → `8ed65ec`, GitHub Release "DUO 0.3.0-rc.5"(draft 아님, prerelease true, tarball 첨부). GitHub latest release는 계속 v0.2.2
- [x] `pnpm release:verify-published` OK(problems 0, channel prerelease, dist-tags next 0.3.0-rc.5·latest 0.2.2, tag commit = H-74 target)

## 0.3.0-rc.4 (H-74, 2026-10-10 prerelease, dist-tag `next`, `v0.3.0-rc.4` = `96031d8`)

Prerelease on branch `next`: rc.3 이후의 T44(review-pending), T45(Issue `implements.paths`, H-78), T46·T47·T50(Context exact path·Symbol token, `./`·역슬래시 경로), T49(Review Decision lifecycle), T48(test 격리)을 담는다. H-74 exact target `96031d8983978a201e353342f1c67309dcbfecb3`. stable 0.3.0 승격은 하지 않았고 `next`를 `main`에 merge하지 않았다. External Validation 01은 정확히 0.2.1이다. [release notes](https://github.com/kanghyunsoon/duo/blob/next/docs/release/notes-0.3.0-rc.4.md)

- [x] version 0.3.0-rc.4, release lock(diff는 version 2줄, 67 packages), release notes(`next` `96031d8` = source candidate). T50 product commit `2df00b7`의 verify·docs·CI(37923824859) 통과 기록은 별도이고 gate는 새 commit에서 다시 실행
- [x] tarball `duo-director-cli-0.3.0-rc.4.tgz` 24,378,111 B(unpacked 114,184,681 B), 7,468 files, bundled 67, sha1 `2eeb53fa43f1b433599856b2d98be2281f2b461e`, sha256 `af782c381740ee25a22dc81058e996bb1f496d87a5af3097d1ea0c164d62ceee`, integrity `sha512-1c94ejdonhqRnBD5UBau7AlLaprGRNNK6Bf+RSUzc7YBScS/1dIlXDGYb9ziSooiQqOITSW/mRRBJfJgYTGZ/w==`, runtime tree `264ab643bb960f509d537f4097c56120b4f368123fe729fd5d1b330d64d09251`. preflight 재pack과 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 37935400981) success
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel prerelease, branch next = next, upstream origin/next, dry-run tag next): verify, grammar, benchmark smoke, 배포 E2E, conformance(97/0, C209 20/0), upgrade(0.2.0 → RC), audit high/critical 0·deprecated 0, secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC. 앞선 두 번은 BLOCKED: 1차 CI 진행 중·npm 로그인 만료, 2차 full verify 부하에서 `tests/install/install.e2e.test.ts`의 두 번째 MCP probe(30초)가 `verify-failed`(같은 commit의 다른 verify·packed conformance·CI·단독 5회 통과, 코드 변경 없이 재실행, 부하 의존 flaky로 기록)
- [x] upgrade 0.2.2 → RC, 설치 matrix npm 10/11/12 global과 npm 11 local(runtime tree, package 밖 설치 0, MCP 9, BLOCK, `--fail-on block` 4, invalid Truth fail-closed), 칸별 T42(TASK-014 7/7, TASK-010 6/6)·canonical Decision(틀린 digest 거부)·T46/T47/T50 Context, packed T49·N1 e2e, T45(TASK-015 → D-004·D-005), T44 PTY(2개 확정, 1개 pending, non-TTY 거부), downgrade rc.4 → 0.2.2 fail-closed(`imported_paths`, `implements.paths`; 0.2.1은 누락·PASS)
- [x] H-74 기록(main `b6c8aaa`, target `96031d8`)
- [x] npm publish `@duo-director/cli@0.3.0-rc.4` `--tag next --access public`(검증한 tarball 그대로, 2FA 1회): registry integrity·shasum·fileCount = RC, `next` = 0.3.0-rc.4, `latest` = 0.2.2 그대로, rc.3 공개 상태 그대로
- [x] registry 설치(`@duo-director/cli@next`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.0-rc.4`, runtime tree, package 밖 설치 0, doctor, MCP 9, canonical BLOCK, invalid Truth fail-closed, T42, T46/T47/T50, T45
- [x] annotated tag `v0.3.0-rc.4` → `96031d8`, GitHub Release "DUO 0.3.0-rc.4"(draft 아님, prerelease true, tarball 첨부). GitHub latest release는 계속 v0.2.2
- [x] `pnpm release:verify-published` OK(problems 0, channel prerelease, dist-tags next 0.3.0-rc.4·latest 0.2.2, tag commit = H-74 target)

## 0.3.0-rc.3 (H-74, C247, 2026-10-07 prerelease, dist-tag `next`, `v0.3.0-rc.3` = `ea4a561`)

Prerelease on branch `next`: rc.2와 같은 제품(MCP SDK 2.2.0)에 release channel 수정(C247)만 더했다. H-74 exact target `ea4a5617292024486e53d2fb58fd0c76fa8bf729`. stable 0.3.0 승격은 하지 않았고 `next`를 `main`에 merge하지 않았다. External Validation 01은 정확히 0.2.1이다.

- [x] release tooling(`next` `4b1662e`): `scripts/release/channel.mjs`가 version으로 channel을 정한다(stable: main·origin/main·latest·GitHub prerelease false, prerelease: next·origin/next·next·true, 다른 branch는 blocker, override 없음). preflight는 `git-branch`·`git-upstream`·`git-not-pushed`와 dry-run dist-tag를 이 규칙으로 정하고 report `channel`을 남긴다. verify-published는 channel dist-tag, prerelease일 때 latest가 stable로 남았는지, GitHub Release prerelease 표시를 확인한다. unit test 7개(`tests/workspace/release-channel.test.ts`). 제품 코드 변경 0
- [x] version 0.3.0-rc.3과 release notes(`next` `ea4a561` = source candidate)
- [x] tarball `duo-director-cli-0.3.0-rc.3.tgz` 24,370,922 B(unpacked 114,163,347 B), 7,468 files, bundled 67, sha1 `1018abaa81066f1ef7e85b9f476d8052aa2a4220`, sha256 `f6e29e3c17db3f0004a80d13509a23b3af76c3796b4961f6bd832f8be995500b`, integrity `sha512-TyT8MwaVP0Zb0ouO4EqGyHzt8pGs/fs6EItLptRpEh6SFmwGcRsXDQFMkpagu3jB6eBvT+TIxSX3WZz9RyQVkw==`, runtime tree `264ab643bb960f509d537f4097c56120b4f368123fe729fd5d1b330d64d09251`. preflight 재pack과 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 37591762901) success
- [x] `pnpm release:preflight` READY(ready·codeReady·externalReady true, blockers 0, releaseChannel prerelease, branch next = next, upstream origin/next, publish dry-run tag next): verify, grammar, benchmark smoke, 배포 E2E, conformance(97/0, C209 20/0), upgrade(0.2.0 → RC), audit high/critical 0, secret·절대경로 0, license 비허용 0, dry-run 7,468 = RC
- [x] upgrade 0.2.2 → RC, 설치 matrix npm 10/11/12 global과 npm 11 local(runtime tree, MCP 9, BLOCK, `--fail-on block` 4, invalid Truth fail-closed), 칸별 T42 packed 회귀(TASK-014 7/7, TASK-010 6/6)와 canonical Decision demo(틀린 digest 거부 포함), downgrade rc.3 → 0.2.2 fail-closed(0.2.1은 WARN·claim 0)
- [x] H-74 기록(main `e308776`, target `ea4a561`)
- [x] npm publish `@duo-director/cli@0.3.0-rc.3` `--tag next --access public`(검증한 tarball 그대로, 2FA 1회): registry integrity·shasum·fileCount = RC, `next` = 0.3.0-rc.3, `latest` = 0.2.2 그대로
- [x] registry 설치(`@duo-director/cli@next`) npm 10/11/12 global과 npm 11 local: `duoctl 0.3.0-rc.3`, runtime tree, package 밖 설치 0, doctor, MCP 9, canonical BLOCK, invalid Truth fail-closed, T42
- [x] annotated tag `v0.3.0-rc.3` → `ea4a561`, GitHub Release "DUO 0.3.0-rc.3"(draft 아님, prerelease true, tarball 첨부). GitHub latest release는 계속 v0.2.2
- [x] `pnpm release:verify-published` OK(problems 0, channel prerelease, dist-tags next 0.3.0-rc.3·latest 0.2.2). 같은 tooling으로 공개 0.2.2도 OK(stable)

## 0.3.0-rc.2 candidate (branch `next`, H-77): VALIDATED, NOT RELEASED

`next`의 prerelease candidate(`299b39b`). 제품·보안 gate는 통과했지만 release preflight가 H-70 dual-track prerelease 정책을 아직 반영하지 못해 release하지 않았다(C247). 제품 실패도 보안 실패도 아니다. commit `299b39b`과 tarball은 바꾸지 않고 보존하며, release candidate는 rc.3가 대체한다.

- [x] 0.3.0-rc.1 candidate `82246f4`(`duo-director-cli-0.3.0-rc.1.tgz` 24,347,554 B, sha1 `8b2f0578d32ab289e11c905f599565bdf19e6936`, integrity `sha512-ZA8Olc…ClgA==`, runtime tree `f4d122fd…`): **failed / obsolete**. bundled `@modelcontextprotocol/client` 2.1.0이 GHSA-6qxp-vccf-f47h 범위. commit·tarball은 바꾸지 않고 보존, publish 없음
- [x] `next`: `adaafca` MCP SDK 2.2.0, `f106606` upgrade journey 비교 수정(main `f186bbb`과 같음), `299b39b` version 0.3.0-rc.2·release notes·rc.1 notes에 미출시 표시. source candidate `299b39bf17e07b12a4393d3af4e9a481e8017a4e`
- [x] tarball `duo-director-cli-0.3.0-rc.2.tgz` 24,370,928 B(unpacked 114,163,347 B), 7,468 files, bundled 67, sha1 `21f76666260f71a2a9a5fd38169a7b367a35769f`, sha256 `80e4c88355f6f2fc08844156e26f882fa5bd13583eaa266e2bde9fcace287ccd`, integrity `sha512-SgUajO9y…uhcA==`, runtime tree `264ab643…`(0.2.2와 같음). preflight 재pack과 독립 `pack-cli --out` 모두 byte 동일
- [x] CI 3 OS(run 37583083135, `299b39b`) success
- [x] `pnpm release:preflight`: blocker는 `git-branch`("release candidates are cut from main") 1개. dual-track(H-70)상 prerelease는 `next`에서 자르므로 정책 검사와 충돌한다. 나머지는 모두 통과: verify, grammar, benchmark smoke, 배포 E2E, conformance(97 pass / 0 fail, C209 20/0), upgrade(공개 0.2.0 → RC), audit high/critical 0·deprecated 0·artifact = lock, secret·절대경로 0, license 비허용 0, `npm publish --dry-run`(7,468 entries = RC, bundled 67)
- [x] upgrade journey 공개 0.2.2 → RC: ts·python·cpp·sparse 모두 current, Truth 불변
- [x] 설치 matrix: npm 10.9.9·11.21.0·12.2.0 global, npm 11.21.0 project-local 4칸 모두 `duoctl 0.3.0-rc.2`, 설치 트리 = runtime tree, doctor, MCP tool 9개, 정상 BLOCK, `--fail-on block` 종료 4, 모르는 field Truth fail-closed(review 1·doctor 6·MCP `isError`)
- [x] packed T42 회귀(4칸 각각): TASK-014 budget 6,000·12,000 AC 7/7, TASK-010 6,000·12,000 AC 6/6(L3, budget 이내)
- [x] canonical(4칸 각각): MCP `duo_propose_decision`(`imported_paths`, block) → preview(proposer agent) → 틀린 digest의 confirm 거부(`DECISION_CONFIRM_PREVIEW_CHANGED`) → digest confirm → 위반 import → BLOCK(`forbidden-import`, `not-in-adoption-baseline`), `--fail-on block` 4
- [x] 실제 Codex demo(npm 10 설치본): Codex가 MCP로 P-001 제안, terminal preview에 `Proposed by … (agent)`·`Forbids scope repository-wide`, ID 입력으로 D-001, Codex가 위반 파일 작성, 사람 review BLOCK `[blocking, not-in-adoption-baseline]`, `--fail-on block` 4, YAML 수동 편집 0. 위반 단계의 Codex 세션(workspace-write)에는 MCP tool이 붙지 않아 Codex가 `duoctl review` CLI로 BLOCK을 확인했다. 같은 상태에서 MCP `duo_review_changes` 직접 호출도 BLOCK이고 MCP 서버는 2.1 s에 tool 9개로 기동
- [x] downgrade: rc.2가 만든 `imported_paths` Decision 저장소를 공개 0.2.2로 열면 review 1·verdict 없음·`PROJECT_TRUTH_INVALID`·doctor 6·`--fail-on block` 1, Truth 불변. 공개 0.2.1은 WARN·claim 0·doctor ready·`--fail-on block` 0(지원하지 않는 downgrade의 증거)

## 0.2.2 (H-75, H-77, C243, C244, 2026-10-07 release, `v0.2.2` = `c4c7895`)

Correctness·security patch([release notes](notes-0.2.2.md), [호환성 분류](compatibility.md#022-변경-분류-t43-h-75)). v0.2.1에서 만든 `release/0.2.2`에 `next`의 T40 N1 수정만 backport했다. 권위 있는 작업은 일부만 읽힌 Project Truth에서 실행하지 않고 `PROJECT_TRUTH_INVALID`로 실패한다. H-71, Informed Confirm, `imported_paths`, provenance 표시(H-73), explicit seed(H-76) 등 0.3 기능은 넣지 않는다. External Validation 01은 계속 정확히 0.2.1이다.

- [x] backport: v0.2.1 위에 `0c59d47` cherry-pick, 충돌 3곳(import 줄, message, diagnostic persistence)은 0.2.1 줄을 유지하고 N1 줄만 넣음
- [x] correctness test: core `authority.test.ts`, e2e `tests/cli/truth-fail-closed.e2e.test.ts`(0.3 전용 `imported_paths`, 모르는 field, 잘못된 YAML·타입, 깨진 proposal: review·context 종료 1과 verdict 없음, `--fail-on`도 실패, status `truth.errors`, doctor invalid, decision list, Decision confirm·reject 거부, MCP `isError`, UI review route failed, Truth 파일 불변, 고친 Truth는 다시 BLOCK)
- [x] 정상 저장소: 공개 0.2.1 설치본과 0.2.2 build의 review·context JSON이 같음(WARN·BLOCK 두 경우, 실행 시간 field만 다름)
- [x] version 0.2.1 → 0.2.2: `apps/cli/package.json`, release lock의 package version 두 곳(의존성 트리 불변), README·07의 현재 version 예시
- [x] 로컬 `pnpm verify`(101 files, 1,020 pass / 7 skip)
- [x] release tooling: `release:upgrade`가 status `truth` 객체 전체를 비교해 additive `truth.errors: []` 때문에 실패했다. 개수 field(requirements·decisions·constraints·declaredGaps)만 비교하고 RC의 `truth.errors`가 비어 있는지 따로 확인하도록 고침(제품 출력 불변). upgrade journey 공개 0.2.1 → RC: ts·python·cpp·sparse 모두 current, Truth 불변
- [x] RC tarball 설치 matrix(Windows, Node 24.18.0): npm 10.9.9·11.21.0·12.2.0 global, npm 11.21.0 project-local 4칸 모두 `duoctl 0.2.2`, 설치 트리 = `dist/runtime-tree.json`(67 package, 불일치·package 밖 설치 0), doctor, MCP tool 9개, 정상 review BLOCK과 `--fail-on block` 종료 4, 모르는 field가 있는 Decision은 review 종료 1(verdict 없음, `PROJECT_TRUTH_INVALID`)·doctor 6·MCP `isError`, Truth 불변
- [x] 첫 RC `f186bbb`(`duo-director-cli-0.2.2.tgz` 24,334,130 B, sha1 `e66ab2cdb48b2c6b97c34eea4b931ac82e8db451`, integrity `sha512-cC0m17aG…xvFN2g==`): **INVALIDATED**. reason: `release:audit` / GHSA-6qxp-vccf-f47h. `pnpm release:preflight`는 BLOCKED(codeReady false, externalReady true, blocker `audit` 1: bundled `@modelcontextprotocol/client` 2.1.0이 upstream High advisory 범위). npm publish·tag·GitHub Release는 없었다. 위 upgrade journey와 설치 matrix는 이 RC의 기록이며 새 RC로 승계하지 않는다
- [x] H-77 security exception: MCP SDK release group만 갱신. PoC(`aed684d`의 격리 worktree 두 곳)

| 항목 | 2.1.0(기존) | 2.2.0 | 2.3.1 |
|---|---|---|---|
| GHSA-6qxp-vccf-f47h | 해당 | 해소(first patched) | 해소 |
| `release:audit` high/critical | 1 / 0 | 0 / 0 | 0 / 0 |
| resolved client·server·core | 2.1.0 | 2.2.0 | 2.3.1 |
| runtime package 수 | 67 | 67(version 변경 3, 추가·삭제 0) | 67(version 변경 3, 추가·삭제 0) |
| install script | 0 | 0 | 0 |
| SDK license | MIT | MIT | Apache-2.0 |
| MCP initialize·protocol | 2025-06-18 | 동일 | 동일 |
| tools/list(이름·schema) | 9 | 동일 | 동일 |
| `duo_get_status`, 잘못된 인자·없는 tool 오류 | 기준 | 동일 | 동일 |
| stdio probe(install codex·claude-code verify, doctor agent) | ok | ok | ok |
| MCP·install·integration·workspace test | 기준 | 12 files, 155 pass | 12 files, 155 pass |

선택: 2.2.0. advisory를 해소하는 최소 version이고 위 조건을 모두 만족한다. 2.3.1도 동작은 같지만 license가 바뀌고 변경 폭이 더 커서 stable patch에 넣지 않는다. `core`는 직접 의존성으로 추가하지 않았고 lock에서 2.2.0으로 해석된다. DUO의 SDK client 사용처는 stdio launch probe(`packages/integration/src/mcp/probe.ts`) 하나이고 OAuth·HTTP transport를 쓰지 않는다. 그래도 vulnerable package가 artifact에 있었으므로 audit blocker를 따른다

- [x] 새 RC `c4c7895`(H-77 SDK 2.2.0): `duo-director-cli-0.2.2.tgz` 24,359,281 B(unpacked 114,133,875 B), 7,468 files, bundled 67, sha1 `20d20ff1d74c1479c4624845806ee995d0d3c8dd`, sha256 `5899eefd0bd0f10d974307f819cf3014305e655aa66522a73e48225012aa6422`, integrity `sha512-/dnNTyf0…LiX7w==`, runtime tree `264ab643…`. preflight의 재pack과 PoC worktree의 독립 pack 모두 byte 동일
- [x] CI 3 OS(run 37572543060, `c4c7895`) success
- [x] `pnpm release:preflight` READY(codeReady·externalReady true, blocker 0): verify(첫 실행은 full verify 부하에서 `python-definitions.e2e` 180 s timeout 1건, 단독 25 s 통과, 코드 변경 없이 재실행 통과), grammar, benchmark smoke, 배포 E2E, conformance, upgrade(공개 0.2.0 → RC), audit high/critical 0·deprecated 0·artifact = lock, secret·절대경로 0, license 비허용 0, `npm publish --dry-run`(7,468 entries = RC, bundled 67)
- [x] upgrade journey 공개 0.2.1 → RC: ts·python·cpp·sparse 모두 current, Truth 불변
- [x] RC tarball 설치 matrix: npm 10.9.9·11.21.0·12.2.0 global, npm 11.21.0 project-local 4칸 모두 `duoctl 0.2.2`, 설치 트리 = runtime tree, doctor, MCP tool 9개, 정상 review BLOCK, `--fail-on block` 종료 4, 모르는 field가 있는 Decision은 review 1·doctor 6·MCP `isError`, Truth 불변
- [x] npm publish(검증한 RC tarball 그대로, 브라우저 2FA 승인 1회): registry version·integrity·shasum·fileCount = RC, `latest` = 0.2.2
- [x] annotated tag `v0.2.2` → `c4c7895`, GitHub Release "DUO 0.2.2"(draft·prerelease 아님, 본문 = release notes, 상대 링크만 `v0.2.2` 기준 절대 링크로). `v0.2.1`·`v0.2.0`은 그대로
- [x] `pnpm release:verify-published` OK(problems 0)
- [x] registry 설치 matrix: npm 10.9.9·11.21.0·12.2.0 global, npm 11.21.0 project-local 4칸 모두 위와 같은 검사 통과(npm 10 칸의 첫 시도는 publish 직후 로컬 metadata cache 때문에 ETARGET, 다시 실행해 통과)
- [x] External Validation 01은 정확히 0.2.1 그대로다. 참가자 version을 0.2.2로 옮길지는 별도 Human Decision이다

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
