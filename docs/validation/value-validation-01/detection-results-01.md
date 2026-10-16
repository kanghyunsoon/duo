# Value Validation 01: Part 1 detection results

측정일 2026-10-15, 공개 `@duo-director/cli@0.3.3`(npm 11 전역 설치본), ESLint v10.11.0, Node.js v24.18.0, Windows. LLM과 네트워크를 쓰지 않는 결정적 테스트이며 두 번 실행해 판정과 claim이 같았다. 원본: [detection-01.json](../../../bench/value-validation/results/detection-01.json). 사례와 정답: [scenarios.md](scenarios.md).

**이 결과는 사람이 만든 사례 17개에서 각 도구가 규칙을 어떻게 판정하는지 보여 줄 뿐이다.** 실제 에이전트가 이런 변경을 얼마나 자주 만드는지, 그래서 실제 작업에서 무엇을 막는지는 Part 2(미실행)가 잰다.

| Checker | TP | FP | TN | FN | Precision | Recall | F1 | FP rate | WARN/ASK only | Errors | Out of scope |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B gate (ESLint + check-deps) | 6 | 0 | 8 | 0 | 1 | 1 | 1 | 0 | - | - | L1 pass, L2 pass, L3 pass |
| DUO alone | 6 | 1 | 7 | 1 | 0.857 | 0.857 | 0.857 | 0.125 | D2 warn, D3 warn | - | L1 pass, L2 pass |
| C gate (B + DUO) | 7 | 1 | 7 | 0 | 0.875 | 1 | 0.933 | 0.125 | D2 warn | - | L1 pass, L2 pass |
| Case | Category | Rule | Truth | B gate | DUO | DUO claims |
|---|---|---|---|---|---|---|
| N1 | 1 | R1 | compliant | pass | pass | - |
| N2 | 1 | R3 | compliant | pass | pass | - |
| N3 | 1 | R2 | compliant | pass | pass | - |
| N4 | 1 | none | compliant | pass | pass | - |
| V1 | 2 | R1 | violation | block | block | decision-forbids-import CONFLICT introduced |
| V2 | 2 | R1 | violation | block | block | decision-forbids-import CONFLICT introduced |
| V3 | 2 | R2 | violation | block | block | decision-forbids CONFLICT introduced |
| V4 | 2 | R3 | violation | block | block | decision-forbids CONFLICT introduced |
| L1 | 3 | R1 | violation | pass (out of scope) | pass (out of scope) | - |
| L2 | 3 | R1 | violation | pass (out of scope) | pass (out of scope) | - |
| L3 | 3 | R1 | violation | pass (out of scope) | block | decision-forbids-import CONFLICT introduced |
| L4 | 3 | R1 | compliant | pass | block | decision-forbids-import CONFLICT introduced |
| L5 | 3 | R3 | violation | block | block | decision-forbids CONFLICT introduced |
| H1 | 4 | R2 | compliant | pass | pass | - |
| D1 | 6 | R1 | compliant | pass | pass | - |
| D2 | 6 | R3 | compliant | pass | warn | decision-forbids CONFLICT pre-existing-touched |
| D3 | 6 | R1 | violation | block | warn | decision-forbids-import CONFLICT pre-existing-touched |
Checker time per case (median ms): B gate 527, DUO review with --refresh 2043.

## 읽는 법

- B gate(ESLint + dependency 검사)는 자기 검사 범위 안의 사례 14개에서 막아야 할 위반 6개를 모두 막았고 오탐이 없었다. 이 fixture에서 기본적인 위반 탐지는 B만으로 충분했다.
- DUO가 B에 더한 것은 L3 하나다. UI가 `createRequire`로 legacy-db를 불러오는 경우로, `no-restricted-imports`가 require를 보지 않아 B의 범위 밖이었다.
- DUO 단독의 오탐 1건(L4): R1은 UI 코드만 막는데, DUO의 `forbids.imported_paths`는 저장소 전체에 적용되고 import하는 쪽으로 좁힐 수 없다. 그래서 service의 정상 import를 BLOCK했다. 규칙을 DUO로 표현할 수 없는 경우이며 0.3.3 문서에 적힌 동작이다.
- DUO 단독의 미탐 1건(D3): legacy UI page에 legacy-db import를 하나 더 넣은 변경을 `pre-existing-touched`(WARN)로 보고하고 막지 않았다. adoption baseline이 "이 파일 → legacy-db" 관계를 이미 갖고 있어, 같은 관계의 새 import 구문을 기존 부채의 수정으로 분류했다. B는 `eslint-disable-next-line`이 첫 줄만 덮으므로 막았다.
- D2(legacy MemorySessionStore 본문 수정)는 DUO가 WARN으로 보고했다. 규칙상 막을 일이 아니므로 판정은 맞고, 알림이 하나 더 생긴 비용으로만 센다.
- 둘 다 못 본 것: barrel을 거친 import(L1), 계산된 dynamic import(L2). 두 도구 모두 문서상 범위 밖이다.
- 도구 실행 시간(사례당 중앙값): B gate 약 0.5초, DUO review(`--refresh` 포함) 약 1.9초.

C gate(B + DUO)는 범위 안 Recall이 1로 B와 같고, 범위가 넓어진 대신(L3) 오탐 1건(L4)이 생겼다. 이 fixture에서 DUO를 더해 얻은 탐지는 1건, 잃은 정확도는 오탐 1건이다. 이것만으로는 C가 B보다 낫다고 말할 수 없다.

