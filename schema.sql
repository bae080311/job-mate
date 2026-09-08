CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,            -- worknet | saramin
  source_id      text NOT NULL,
  title          text NOT NULL,
  company        text NOT NULL,
  biz_no         text,                     -- 병무청 조인 키 (없을 수 있음)
  region         text,
  edu_min        text,                     -- 원문 학력조건. hs_ok 판정 근거를 남긴다
  hs_ok          boolean NOT NULL,
  -- 병역지정업체 판정. boolean 이면 '지정업체 아님'과 '확인 못 함'이 같은 값이 되는데,
  -- 이 둘은 사용자에게 완전히 다른 의미다. 오탐 = 없는 병역특례를 있다고 표시 =
  -- 고졸 학생이 진로를 걸고 지원 → 오탐 0건이 목표, 애매하면 unknown 으로 남긴다.
  mma_status     text NOT NULL DEFAULT 'unknown'
                 CHECK (mma_status IN ('designated', 'not_listed', 'unknown')),
  mma_matched_by text CHECK (mma_matched_by IN ('biz_no', 'name')),  -- 판정 근거
  salary         text,
  url            text NOT NULL,
  posted_at      timestamptz,
  closes_at      timestamptz,
  raw            jsonb NOT NULL,           -- 원본 보관: 파싱 바꿔도 재수집 불필요
  collected_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS jobs_hs_open_idx ON jobs (hs_ok, closes_at);

-- 2단계에서 채움
CREATE TABLE IF NOT EXISTS mma_companies (
  biz_no text PRIMARY KEY,
  name   text NOT NULL,
  kind   text,
  as_of  date NOT NULL   -- 지정은 매년 바뀌고 취소된다. 기준일 없으면 낡은 명단인지 알 수 없음
);

-- 3단계에서 채움
CREATE TABLE IF NOT EXISTS job_chunks (
  id        bigserial PRIMARY KEY,
  job_id    bigint REFERENCES jobs(id) ON DELETE CASCADE,
  content   text NOT NULL,
  embedding vector(1024)               -- bge-m3
);

CREATE INDEX IF NOT EXISTS job_chunks_emb_idx
  ON job_chunks USING hnsw (embedding vector_cosine_ops);
