# Release 0.1.0 결정 요청 (Decision Packets)

Release Hardening에서 사람이 결정해야 하는 항목이다. 각 항목의 추천은 release engineering 관점의 제안이며 법률 자문이 아니다. 결정 전에는 문서·코드의 Truth를 바꾸지 않았다. 결정은 `docs/conflicts.md`의 Human 결정 기록(H-)으로 남긴 뒤 반영한다.

## DP-1. REQ-NFR-004 성능 목표

**결정됨(H-44, 2026-09-29)**: B안. REQ-NFR-004를 benchmark-scoped target으로 명확히 했다(목표 수치 유지, 조건 명시, NOT MET 이력 보존). 아래는 결정 전 비교 기록이다.

**현재 문장**: “초기 목표(benchmark로 검증 후 확정): 소스 1만 파일 init 60초 이내, 변경 20파일 이하 증분 인덱싱 2초 이내, `duoctl context` 1초 이내.”

**전제 확인**: 출처 D§17(기획서 17. CLI)에는 이 수치가 없다. T00에서 정한 초기값이며 기준 환경, cold/warm, 저장소 크기·형태, 측정 operation이 정해져 있지 않다.

**T19 실측**([performance-benchmark](../performance-benchmark.md), Windows 11 / Core Ultra 7 155H, synthetic fixture):

| 목표 | 실측 | 판정(현재 문장 그대로) |
|---|---|---|
| 1만 파일 init 60초 | 5,000 파일 초기 index 17.7~20.5 s. 1만 파일은 측정 안 함 | 미확인 |
| ≤20 파일 증분 2초 | 5개 변경: medium 0.91 s, large 2.39 s(장기 실행). 1개 변경 cold large 3.4~3.6 s | large에서 NOT MET |
| context 1초 | small 0.7 s, medium 1.0~1.1 s, large 2.2~2.5 s(장기 실행). cold CLI small 1.5~1.9 s | medium 이상에서 NOT MET |

**선택지**

| | A. 기존 universal target 유지 | B. benchmark-scoped target으로 명확화(추천) |
|---|---|---|
| 문장 | 그대로 | 저장소 크기, cold/warm, operation, 기준 환경을 명시한 benchmark 목표. “benchmark target이며 기기 간 보장이 아니다”를 명시 |
| 0.1.0 상태 | medium·large에서 NOT MET로 기록하고 release | 목표별 MET/NOT MET를 조건과 함께 기록 |
| 장점 | 목표가 느슨해지지 않음 | 측정 가능하고 재현 가능. 사용자에게 잘못된 보장을 주지 않음 |
| 단점 | 조건이 없어 판정이 기기마다 달라짐 | 목표 수치 자체도 사람이 다시 정해야 함 |

**B의 문장 예시**(수치는 사람이 정한다): “Interactive performance targets are benchmark targets, not cross-machine guarantees. 기준 환경(문서화된 benchmark 기기)의 `duo-bench-fixture/1`에서: small(100)·medium(1,000) 장기 실행 context ≤ X s, large(5,000) 장기 실행 context ≤ Y s, 단일 파일 증분 index ≤ Z s(장기 실행), cold CLI는 참고값으로만 기록.” 현재 측정치로는 X=1.2, Y=3, Z=3 수준이 현재 상태를 기술하는 값이다. 이 값을 목표로 할지, 더 공격적인 목표와 후속 최적화(C202)를 둘지는 결정이 필요하다.

**0.1.0 release 영향**: REQ-NFR-004의 priority는 should이므로 어느 선택지든 release를 막지 않는다. README와 사용자 문서에는 결정 전까지 “context 1초 이내” 같은 보장을 쓰지 않는다.

## DP-2. DUO LICENSE (C164)

**결정됨(H-44, 2026-09-29)**: Apache License 2.0. 루트 `LICENSE`(apache.org 원문), `apps/cli/package.json` `license: Apache-2.0`, package에 `LICENSE` 포함. 아래는 결정 전 비교 기록이다.

결정 전에는 DUO 자체 license가 없었고 package 값도 “사용 허가 없음”을 뜻하는 값이었다. 제3자 license(React, Tree-sitter grammar, npm 의존성)는 `dist/THIRD_PARTY_NOTICES.md`와 `dist/grammars/LICENSE-*`로 따로 배포되며 이 결정과 무관하다.

| | MIT | Apache-2.0 |
|---|---|---|
| 성격 | permissive, 짧고 단순 | permissive |
| 특허 | 명시적 patent license 조항 없음 | 명시적 patent grant와 소송 시 termination 조항 |
| 조건 | 저작권·허가 고지 유지 | 고지 유지, 변경 파일 표시, NOTICE 파일이 있으면 유지 |
| 문서 | 매우 짧음 | 길고 복잡함 |

**추천**: 코드 재사용을 제한할 요구가 없다면 Apache-2.0. 공개 개발 도구·인프라 소프트웨어에서 명시적 patent grant가 사용자와 기여자 모두에게 분명함을 준다. 선택 후 할 일: 루트 `LICENSE` 추가, `apps/cli/package.json`의 `license`(`Apache-2.0` 또는 `MIT`), pack이 `LICENSE`를 package에 포함하도록 allowlist 확장, release:preflight blocker 해제.

## DP-3. npm scope와 공개 저장소 (C168)

보안 신고 채널(H-44): `SECURITY.md`는 GitHub Private Vulnerability Reporting을 공식 채널로 정했다. 이 기능은 저장소가 public일 때 켤 수 있으므로 **Human action required: 저장소를 public으로 전환할 때 Settings → Code security에서 Private vulnerability reporting을 켠다.** DUO는 저장소 설정을 바꾸지 않는다.

- 이름은 `@duo-director/cli`로 유지한다. 다른 이름으로 자동 대체하지 않는다.
- 2026-09-29 확인: registry는 `https://registry.npmjs.org/`, 이 PC는 npm 로그인이 없고(`ENEEDAUTH`), `@duo-director/cli`는 registry에 없다(404, 0.1.0 미존재). `@duo-director` scope(npm organization)의 존재와 publish 권한은 로그인 전에는 확인할 수 없다.
- 결정·실행 필요: npm 계정 로그인, `duo-director` organization 생성 또는 권한 확보. 불가능하면 namespace 변경을 사람이 결정한다(이름 변경은 문서, bin 안내, MCP 설정 예시 전반에 영향).
- GitHub 저장소 `kanghyunsoon/duo`는 현재 private다. package metadata의 repository/homepage/bugs가 이 저장소를 가리키므로, 공개하지 않으면 사용자에게 열리지 않는 링크가 된다. 공개 여부를 결정해야 한다.

## DP-4. 실제 OpenAI smoke

fake transport 테스트는 실제 smoke가 아니다. publish 전 한 번 `DUO_OPENAI_SMOKE=1`, `OPENAI_API_KEY`, `DUO_OPENAI_SMOKE_MODEL`을 주고 `pnpm test:openai-smoke`를 실행해야 한다. 사용할 model과 비용 부담 주체는 사람이 정한다.

**결정(H-45, 2026-09-29): Deferred / Optional integration verification.** 공식 OpenAI API key가 없고 0.1.0의 주 사용 목적은 Codex·Claude Code와 MCP 연결이다(LLM은 기본 OFF). 실제 smoke는 0.1.0 release blocker에서 빠지고 key가 생기면 실행하는 선택 검증으로 남는다. fake transport 테스트를 smoke로 부르지 않는 원칙은 그대로다. GMS 같은 OpenAI Responses API 호환 endpoint는 `OpenAIResponsesProvider`의 공식 endpoint 전용 계약을 바꾸지 않고 0.1.0 이후 별도 Provider로 다룬다(C212).
