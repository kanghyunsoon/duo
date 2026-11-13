# UI 국제화

DUO UI는 `i18next`와 `react-i18next`를 사용하며 한국어를 기본으로 표시합니다. 사이드바의 언어 선택에서 한국어와 영어를 전환할 수 있습니다. 선택은 브라우저 `localStorage`의 `duo.ui.language`에 저장하며, 저장소 접근이 차단된 환경에서도 현재 페이지의 언어 전환은 동작합니다.

번역 리소스는 `packages/ui/src/locales/ko.ts`와 `en.ts`에 있습니다. 두 언어 모두 앱 번들에 포함하므로 번역을 위한 외부 요청은 없습니다. 영어를 fallback으로 사용하고, 언어 변경 시 문서의 `lang`과 제목도 갱신합니다. 브라우저가 없는 렌더링 환경은 기존 CLI 용어 비교를 위해 영어로 초기화합니다.

## 번역 대상

- 탐색 메뉴, 페이지 제목, 폼, 안내 문구, 빈 상태, 결정 확정·거절 창
- 분석 수준, 도입 기준선과 결정 효력 설명, 작업 맵 범례와 그래프 조작 안내
- UI가 구성하는 작업 결과와 수치 설명

Project Truth 원문, 코드, 파일 경로, 엔티티 ID, API 진단 메시지와 기계 상태값(`PASS`, `BLOCK`, `CONFIRMED` 등)은 원래 값을 표시합니다. 프로젝트 내용이나 API 계약은 번역하지 않습니다.

## 문구 추가

두 리소스에 동일한 키를 추가합니다. 일반 문구는 `t(key)`를 사용하고, 동적 문자열은 `{{name}}` 보간을 사용합니다. 링크나 강조 요소를 포함해 언어별 어순이 달라지는 문장은 `Trans`를 사용합니다. `message()`는 DUO가 소유한 기존 표시용 상수에만 사용하며 사용자 문서에는 적용하지 않습니다. 모듈 초기화 시 번역 결과를 저장하면 언어 변경이 반영되지 않으므로 렌더링 시점에 번역합니다.

## 검증

```sh
pnpm exec tsc -b packages/ui
node packages/ui/build.mjs
pnpm exec vitest run packages/ui/src tests/ui/ui.i18n.browser.test.ts tests/ui/authority-labels.test.ts tests/ui/forbids-scope.test.ts tests/ui/provenance-labels.test.ts
```

번역 키·보간 일치, 결정 보호 문구, 원문 보존, 한국어 기본 표시, 언어 전환과 저장, 입력 유지, ID 재입력 조건, 작업 맵 갱신을 검사합니다. 브라우저 검사는 CI의 Chromium 또는 로컬 Chrome/Edge를 사용합니다. 기존 브라우저·접근성 검사는 영어를 명시적으로 선택합니다. 이 검증은 전체 수동 접근성 검사를 대체하지 않습니다.
