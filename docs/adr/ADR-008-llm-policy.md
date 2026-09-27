# ADR-008: LLM 사용 정책

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 결정

- v0.1은 LLM을 호출하지 않는다. `LLMProvider` interface와 `none` 구현만 제공한다.
- interface: `judge(request: { question, context_packet, schema }) → { answer, evidence_refs }`. 입력은 반드시 Compiled Packet이며 Repository 원문을 직접 받지 않는다.
- 모든 지표에 `llm_calls`를 기록한다(v0.1은 항상 0).

## 근거

토큰 최적화 1순위가 "LLM을 호출하지 않는다"이다. 규칙 기반 판정의 한계를 benchmark로 먼저 측정한 뒤 LLM이 필요한 지점만 추가한다. 호출하는 Coding Agent 자신에게 의미 판정을 맡기는 방식은 자기 검수가 되어 제외한다.

## 결과

- Intent 초안은 규칙 기반이라 빈약할 수 있다(C17). 부족한 부분은 UNKNOWN 질문으로 Human에게 넘긴다.
- v0.3 후보: OpenAI 호환 HTTP API 구현 1종(OpenAI와 로컬 서버를 함께 지원), 이후 Anthropic.
