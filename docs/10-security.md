# 10. Security

상태: Draft

## 신뢰 모델

- DUO는 사용자의 로컬 머신에서 사용자 권한으로 실행된다.
- Coding Agent는 **악의적이지 않지만 실수할 수 있는** 주체로 가정한다. DUO는 Agent가 파일 시스템에 직접 쓰는 것을 막을 수 없다. Decision Lock과 .duo 보호는 **강제(enforcement)가 아니라 탐지(detection)** 다. 탐지는 Review의 R-LOCK 규칙과 Git HEAD 기준선으로 한다.
- 적대적 Agent(탐지를 우회하려고 Git 이력까지 조작하는 Agent)는 v0.1 범위 밖이다.

## 위협과 대응

| 위협 | 대응 |
|---|---|
| 비밀 정보가 Context/Evidence로 새어 나감 | 기본 제외: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `secrets.*`, `credentials*`, .gitignore 대상. Packet 생성 시 AWS/GitHub/OpenAI 형식 토큰 패턴을 `[REDACTED]`로 치환 |
| 외부 네트워크 전송 | v0.1은 네트워크 코드가 없다(LLMProvider none). Post-MVP Provider는 opt-in이고 Packet만 전송 |
| UI를 통한 로컬 데이터 노출 | 127.0.0.1 bind, Host 헤더 검사, 쓰기 endpoint 없음, CORS 헤더 없음 |
| Repository 코드 실행 | DUO는 소스를 parse만 하고 실행하지 않는다. 예외는 사용자가 project.yaml에 설정한 `test_command`를 `--run-tests`로 명시했을 때뿐 |
| 경로 조작(Tool 입력) | 모든 경로 입력을 Repository root 기준으로 정규화하고 root 밖이면 거부 |
| Agent 설정 파일 손상 | `duo install`은 `--dry-run`을 제공하고, 수정 전 백업(`.duo/state/backup/`), instruction은 `<!-- duo:begin -->` ~ `<!-- duo:end -->` 블록 안만 교체, 반복 실행해도 결과 동일 |
| Source Code 변경 | DUO 코드베이스에서 파일 쓰기는 `core/fs-guard` 한 곳을 통하고, 허용 경로(.duo/, install 대상 파일)가 아니면 예외를 던진다. 테스트로 검증 |
| 대형/악성 파일로 인한 자원 고갈 | max_file_bytes, 바이너리 탐지, parse timeout(파일당 2초), nodeLimit |
| Supply chain | 의존성 최소화, lockfile 커밋, CI에서 `pnpm audit`(경고만) |

## 데이터 보존

`.duo/evidence/`는 코드 일부(최대 L3 표현)를 담을 수 있으므로 기본 gitignore 대상이다. 공유 여부는 사용자가 결정한다.

## 보고

보안 문제 보고 절차(`SECURITY.md`)는 저장소 공개 전 작성한다.
