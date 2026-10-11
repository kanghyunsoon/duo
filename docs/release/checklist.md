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

const fs=require('fs');const f='docs/release/checklist.md';let s=fs.readFileSync(f,'utf8');const a='## 0.3.0-rc.5 (H-74';const i=s.indexOf(a);if(i<0||s.indexOf(a,i+1)>=0)throw new Error('anchor');s=s.slice(0,i)+fs.readFileSync(process.argv[1],'utf8')+s.slice(i);fs.writeFileSync(f,s);## 0.3.0-rc.5 (H-74, 2026-10-10 prerelease, dist-tag `next`, `v0.3.0-rc.5` = `8ed65ec`)

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
