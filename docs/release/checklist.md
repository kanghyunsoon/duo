# 0.1.0 Release checklist

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

## 상태 (H-45 결정 반영 commit 기준)

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
npm publish .dist/duo-director-cli-0.1.0.tgz --access public --registry https://registry.npmjs.org/
git tag -a v0.1.0 -m "DUO 0.1.0" <release candidate commit> && git push origin v0.1.0
```

publish한 뒤 README의 설치 절을 “Release 후” 흐름으로 바꾼다.

## 알려진 limitation

- Windows에서 설치 직후 첫 명령이 오래 걸릴 수 있다(기준 환경 17~19 s, 이후 1.4~1.5 s). 새로 설치된 JavaScript 파일의 첫 open 비용이며 DUO 작업과 무관하다([performance-benchmark](../performance-benchmark.md#설치-직후-첫-실행-release-hardening)).
- shrinkwrap을 쓰므로 transitive dependency의 보안 수정은 새 DUO release 전까지 반영되지 않는다(C163).
