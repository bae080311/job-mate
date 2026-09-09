---
name: data-quality
description: 공고 수집 후 jobs 테이블의 데이터 품질을 감사한다. 학력 판정 누락률, mma_status 분포, 날짜 파싱 실패율, 중복·URL 유효성을 DB에서 직접 확인하고 결론만 보고한다. `collect.ts` 를 실행한 뒤, 새 소스 어댑터를 붙인 뒤, 또는 "데이터 이상한데" 싶을 때 호출.
---

# 데이터 품질 감사

`jobs` 테이블을 읽어 파이프라인이 조용히 망가진 곳을 찾는다. 수백 행을 훑어야 하므로
결과만 요약해서 돌려준다.

DB: `postgres://jobmate:jobmate@localhost:5434/jobmate`
조회: `docker compose exec -T db psql -U jobmate -d jobmate -c "..."`

## 반드시 확인할 5가지

### 1. 학력 판정 누락 (`hs_ok`)

```sql
SELECT source, edu_min, count(*) FROM jobs GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40;
```

`edu_min` 원문 중 `EDU_LEVELS` 키워드에 안 걸리는 표현을 찾는다. 걸리지 않으면 전부
`false` 로 떨어지므로 **고졸 지원 가능한 공고가 조용히 사라진다.** 발견하면 어떤 문자열을
`collect.ts` 의 `EDU_LEVELS` 어느 등급에 넣어야 하는지까지 제안할 것.

`hs_ok=false` 인데 `edu_min` 에 "고졸"이 보이면 즉시 보고 — 판정 로직 버그다.

### 2. `mma_status` 분포 — 안전 규칙 위반 탐지

```sql
SELECT source, mma_status, mma_matched_by, count(*) FROM jobs GROUP BY 1,2,3;
```

**`mma_status='designated'` 인데 `mma_matched_by='name'` 인 행이 하나라도 있으면 심각한 위반이다**
(CLAUDE.md 1절). 상호명 매칭은 절대 확정으로 승격하면 안 된다. 발견 시 최우선 보고.

사람인 출처인데 `designated` 가 많으면 그것도 이상하다 — 사람인은 사업자번호를 안 준다.

### 3. 날짜 파싱 실패

```sql
SELECT source, count(*) FILTER (WHERE closes_at IS NULL) AS null_close,
       count(*) FILTER (WHERE posted_at IS NULL) AS null_post, count(*) AS total
FROM jobs GROUP BY 1;
```

`closes_at` null 비율이 높으면 `toDate()` 가 그 소스의 형식을 못 읽는 것이다.
**병역일터는 `magamDt` 가 DD/MM/YYYY 로 의심되니 특히 주의.** `raw` 에서 원본 문자열을
뽑아 실제 형식을 확인할 것:

```sql
SELECT DISTINCT raw->>'magamDt' FROM jobs WHERE source='byeongyeokilteo' LIMIT 10;
```

`closes_at` 이 전부 null 이면 검색 쿼리의 `closes_at > now()` 가 **모든 공고를 걸러낸다.**

### 4. 마감된 공고 비율

```sql
SELECT source, count(*) FILTER (WHERE closes_at < now()) AS 마감, count(*) FROM jobs GROUP BY 1;
```

대부분 마감이면 수집이 낡은 것이거나 날짜를 잘못 읽은 것이다.

### 5. 표본 실물 대조

`hs_ok=true` 인 행 3개를 뽑아 `url` 을 WebFetch 로 열고, 실제 공고의 학력조건이
정말 고졸 가능한지 눈으로 확인한다. **이게 유일한 진짜 검증이다** — 나머지는 전부 내부 일관성 검사.

## 보고 형식

발견을 심각도 순으로. 각 항목에 ① 무엇이 ② 몇 건 ③ 어느 파일 어느 줄을 고쳐야 하는지.
문제가 없으면 "이상 없음"과 각 지표 수치만 한 줄씩. **추측으로 채우지 말고 쿼리 결과만 쓸 것.**
