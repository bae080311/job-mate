# 고졸 취업 메이트

고졸·마이스터고 지원 가능 채용공고를 모으고, LLM으로 진로상담·포트폴리오·면접 피드백을 준다.

차별점: **채용공고 × 병무청 병역지정업체 명단 조인** — "고졸 지원 가능 + 산업기능요원
지정업체 + 마감 전" 필터는 어느 채용 사이트도 안 해준다.

계획 전문은 Notion 문서 참고. 현재 **1단계(수집)** 까지 구현됨.

## 빠른 시작

```bash
cp .env.example .env          # API 키 채우기
docker compose up -d          # postgres+pgvector (localhost:5434)

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m pipeline.collect --selftest              # 키 없이 파서 검증
python -m pipeline.collect --probe saramin         # 원본 1건 덤프
python -m pipeline.collect --source saramin --pages 3
```

## API 키

| 소스 | 발급처 | 환경변수 |
| --- | --- | --- |
| 사람인 | https://oapi.saramin.co.kr | `SARAMIN_ACCESS_KEY` |
| 워크넷 | https://www.data.go.kr/data/3038225/openapi.do | `WORKNET_AUTH_KEY` |

## 알려진 미검증 지점

- `pipeline/collect.py` 의 `WORKNET_TAGS` — 워크넷 XML 태그명을 명세서로 확인 못 했다.
  키 발급 후 `--probe worknet` 으로 실제 태그를 찍어서 맞출 것. 사람인 쪽은 공식 가이드 확인함.
- 학력 판정(`EDU_LEVELS`)은 키워드 기반이라 못 잡는 표현이 있다. 실행하면 미판정 원문을
  `⚠` 로 출력하니 표에 추가하면 된다. 모르면 `False`(보수적) — 못 가는 공고를 보여주는 쪽이 더 나쁨.
- 공개 서비스로 띄울 거면 각 API 이용약관의 **재배포 조항** 먼저 확인.

## 다음

- [ ] 2단계 `pipeline/enrich.py` — 병무청 조인, `mma_designated` 채우기
- [ ] 3단계 `pipeline/index.py` + `app/` — RAG
- [ ] 4단계 `evals/` + Langfuse — LLMOps
