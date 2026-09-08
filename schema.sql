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
  mma_designated boolean NOT NULL DEFAULT false,  -- 2단계 enrich.py 가 채움
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
  kind   text
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
