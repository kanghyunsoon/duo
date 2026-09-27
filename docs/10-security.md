# 10. Security

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-SAFETY-001, REQ-NFR-002, REQ-DECISION-003

## 신뢰 모델

- DUO는 사용자 로컬 머신에서 사용자 권한으로 실행된다.
- Coding Agent는 **악의적이지 않지만 실수할 수 있는** 주체로 가정한다. DUO는 Agent가 파일 시스템에 직접 쓰는 것을 막을 수 없다. 따라서 `.duo-project` 보호와 Decision Lock은 **강제가 아니라 탐지**다. 탐지는 lock digest, Git HEAD 기준선, Review의 R-LOCK 규칙으로 한다.
- `duoctl decision`의 TTY 요구와 UI의 ID 재입력은 Agent의 실수를 막는 장치이며 보안 경계가 아니다. lock digest도 무결성 표시일 뿐 서명이 아니다.
- 탐지를 의도적으로 우회하는 적대적 Agent는 v0.1 범위 밖이다.

## 위협과 대응

| 위협 | 대응 |
|---|---|
| 비밀 정보가 Context, Evidence, LLM 요청으로 새어 나감 | 기본 제외(`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `secrets.*`, `credentials*`, .gitignore 대상, `.git/`, `.duo-project/generated|cache|runtime/`). symlink는 따라가지 않고 저장소 밖 대상은 읽지 않는다(TASK-004). Packet 생성 시 알려진 토큰 형식(AWS, GitHub, OpenAI 등)을 `[REDACTED]`로 치환. LLM 요청은 치환이 끝난 Packet만 보냄 |
| 외부 네트워크 전송 | 기본 `llm.provider: none`에서는 네트워크 코드가 실행되지 않는다. Provider를 켜면 설정된 `base_url`로만 보내고, 요청 크기는 `max_input_tokens`로 제한 |
| API Key 노출 | Key는 `api_key_env`가 가리키는 환경 변수에서만 읽고 파일, 로그, metrics, 오류 메시지에 쓰지 않는다 |
| Repository 코드 실행 | DUO는 소스를 parse만 한다. 예외는 사용자가 project.yaml에 설정한 `test_command`를 `--run-tests`로 명시했을 때뿐 |
| 경로 조작(Tool, API 입력) | 모든 경로를 Repository root 기준으로 정규화하고 root 밖이면 거부. `/api/source`는 인덱싱 대상 파일만 허용 |
| Source Code 변경 | 모든 파일 쓰기는 먼저 core의 순수 정책 `checkWriteBoundary`로 판정한다. 허용 영역은 `.duo-project/` 아래의 Project Truth, Human-approved History, Regenerable 영역뿐이고 Repository 밖은 항상 거부한다([03 Write Boundary](03-data-model.md#write-boundary)). 실제 writer는 symlink를 풀어 다시 확인한다. `duoctl install` 대상 파일은 TASK-017에서 별도 writeKind로 추가. 테스트로 검증(AC-002-04) |
| Agent 설정 파일 손상 | `duoctl install`은 `--dry-run`, 수정 전 백업(`runtime/backup/`), `<!-- duo-director:begin -->` 블록 안만 교체, 반복 실행 시 같은 결과 |
| 대형·악성 파일로 인한 자원 고갈 | max_file_bytes, 확장자 기반 fingerprint mode(TASK-004), 파일당 parse timeout 2초(TASK-005 `AST_PARSE_TIMEOUT`), nodeLimit |
| LLM 응답 조작(프롬프트 주입된 코드 주석 등) | 응답은 스키마 검증, Packet 밖 ID 인용 시 폐기, `basis: llm` Claim은 BLOCK 불가 |
| Supply chain | 의존성 최소화, lockfile 커밋, CI에서 `pnpm audit`(경고만) |

## 로컬 HTTP API

UI 서버에 쓰기 endpoint(Decision Confirm/Reject)가 있으므로 다음을 모두 적용한다.

1. `127.0.0.1`에만 bind한다.
2. `Host` 헤더가 `127.0.0.1:<port>` 또는 `localhost:<port>`가 아니면 거부한다(DNS rebinding 방지).
3. POST는 `Origin`이 같은 origin일 때만 받는다.
4. 실행마다 무작위 token을 만들어 시작 URL(`http://127.0.0.1:7346/#t=<token>`)로 전달한다. UI는 이를 메모리에만 두고 `X-Duo-Token` 헤더로 보낸다. token이 없거나 다르면 거부한다.
5. POST는 `application/json`만 받는다(단순 form 요청 차단). CORS 헤더를 보내지 않는다.

## 데이터 보존

- `runtime/reviews/`는 로컬 전용이다.
- `reviews/`(Record)는 Git에 들어갈 수 있으므로 코드 본문을 담지 않고 참조만 담는다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)).
- `cache/llm/`에는 LLM 응답이 저장된다. gitignore 대상이다.

## 보고

보안 문제 보고 절차(`SECURITY.md`)는 저장소 공개 전에 작성한다([conflicts.md Q4](conflicts.md)).
