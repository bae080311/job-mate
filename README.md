# 고졸 취업 메이트

고졸·마이스터고 지원 가능 채용공고를 모으고, LLM으로 진로상담·포트폴리오·면접 피드백을 준다.

차별점: **채용공고 × 병무청 병역지정업체 명단 조인** — "고졸 지원 가능 + 산업기능요원
지정업체 + 마감 전" 필터는 어느 채용 사이트도 안 해준다.

계획 전문은 Notion 문서 참고. 현재 **1단계(수집)** 까지 구현됨.

## 빠른 시작

```bash
cp .env.example .env          # API 키 채우기
docker compose up -d          # postgres+pgvector (localhost:5434)
npm install

npm run selftest                                       # 키·DB 없이 파서 검증
node src/pipeline/collect.ts --probe saramin           # 원본 1건 덤프
node src/pipeline/collect.ts --source saramin --pages 3
```

Node 23.6+ 는 `.ts` 를 그대로 실행한다 (네이티브 타입 스트리핑). 빌드 단계 없음 —
`tsc` 는 타입 검사(`npm run typecheck`)에만 쓴다. tsx/ts-node 안 씀.

## API 키

| 소스 | 발급처 | 환경변수 | 상태 |
| --- | --- | --- | --- |
| 병역일터 채용공고 | https://www.data.go.kr/data/3065599/openapi.do | `MMA_SERVICE_KEY` | 스펙 확인됨, 어댑터 미구현 |
| 사람인 | https://oapi.saramin.co.kr | `SARAMIN_ACCESS_KEY` | 구현됨 |

## 알려진 미검증 지점

- 병역일터 API 명세의 `magamDt` 예시가 `"31/05/2016"` (DD/MM/YYYY) 이고 예시 연도가 2016이라
  **명세가 낡았을 수 있다.** 어댑터 구현 시 `--probe` 로 실측 후 `toDate` 확장할 것.
- 워크넷 어댑터는 로드맵에서 제외되어 TS 이식에서 뺐다 (Python 판이 git `55e7b39` 에 있음).
- 학력 판정(`EDU_LEVELS`)은 키워드 기반이라 못 잡는 표현이 있다. 실행하면 미판정 원문을
  `⚠` 로 출력하니 표에 추가하면 된다. 모르면 `False`(보수적) — 못 가는 공고를 보여주는 쪽이 더 나쁨.
- 공개 서비스로 띄울 거면 각 API 이용약관의 **재배포 조항** 먼저 확인.

## 다음

- [ ] 병역일터 어댑터 — 이 공고들은 전부 `mma_status='designated'` (병무청 지정업체 전용 포털)
- [ ] `src/server.ts` (Fastify) + `src/llm.ts` (@anthropic-ai/sdk)
- [ ] `src/pipeline/index.ts` — LlamaIndex.TS + 임베딩 → RAG
- [ ] 4단계 `evals/` + Langfuse — LLMOps
