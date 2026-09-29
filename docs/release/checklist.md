# 0.1.0 Release checklist

`pnpm release:preflight`가 아래 항목을 검사하고 `.dist/release-preflight.json`(`duo.release-preflight/1`)에 blocker를 기록한다. preflight는 version을 바꾸거나 commit·tag·npm scope 생성·publish를 하지 않는다. 마지막 npm 단계는 `npm publish --dry-run`이다.

## 명령

| 명령 | 내용 | network |
|---|---|---|
| `pnpm release:lock` | `apps/cli/npm-shrinkwrap.json` 재생성(의존성 변경 시). diff를 검토해 커밋 | 필요 |
| `pnpm release:pack` | clean tree 확인 → build → pack → `.dist/release-candidate.json`(commit, branch, clean, version, hash). dirty면 거부(`DUO_RELEASE_ALLOW_DIRTY=1`은 시험용) | 불필요 |
| `pnpm release:audit` | shrinkwrap 트리의 npm advisory와 deprecated 검사 → `.dist/release-audit.json` | 필요 |
| `pnpm release:preflight` | git·CI → verify, grammar, benchmark smoke, 배포 E2E → release:pack → 재현성 → metadata·allowlist·secret·절대경로 → dependency·license → npm identity·registry·scope·version → `npm publish --dry-run` → OpenAI smoke 결과 | 필요 |
| `pnpm test:openai-smoke` | 실제 OpenAI Responses 호출(`DUO_OPENAI_SMOKE=1`, `OPENAI_API_KEY`, `DUO_OPENAI_SMOKE_MODEL`). `.dist/openai-smoke.json`에 commit, model, 확인 항목만 기록 | 필요 |

## 사람이 확인할 항목

- [ ] DUO LICENSE 선택(DP-2)과 `LICENSE` 파일, `apps/cli/package.json` license, package allowlist 반영
- [ ] npm 로그인과 `duo-director` organization publish 권한(DP-3)
- [ ] `@duo-director/cli@0.1.0`이 registry에 없음(preflight가 확인)
- [ ] GitHub 저장소 공개 여부 결정(package metadata 링크)
- [ ] 마지막 commit의 3 OS CI green
- [ ] 배포 E2E green(clean global·local install, MCP, UI, polyglot, LLM 없음)
- [ ] benchmark smoke green
- [ ] 실제 OpenAI smoke green(fake 테스트는 대신하지 않음)
- [ ] `npm publish --dry-run` green, 목록이 release candidate와 같음
- [ ] `release:audit` green
- [ ] README 첫 사용자 흐름 검토
- [ ] release artifact(`.dist/cli-package/`, `THIRD_PARTY_NOTICES.md`, `npm-shrinkwrap.json`) 검토
- [ ] REQ-NFR-004 처리 결정(DP-1, release를 막지 않음)
- [ ] TASK-020(E2E와 문서-구현 대조)을 0.1.0 전에 할지 결정

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
