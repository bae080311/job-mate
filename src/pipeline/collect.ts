/**
 * 채용공고 수집 → jobs 테이블.
 *
 *   node src/pipeline/collect.ts --selftest          # node_modules 없이도 파서 검증
 *   node src/pipeline/collect.ts --probe saramin     # 원본 1건 덤프 (필드명 확인용)
 *   node src/pipeline/collect.ts --source saramin --pages 3
 */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";

// ── 학력 판정 ────────────────────────────────────────────────────────
// 문자열에 등장하는 학력 키워드 중 "가장 낮은" 등급으로 판정한다.
// "초대졸"은 "대졸"에도 걸리지만 Math.min 이라 2로 잡힌다. 순서 의존성 없음.
const EDU_LEVELS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [0, ["무관", "관계없음", "제한없음"]],
  [1, ["초졸", "중졸", "고교", "고졸"]],
  [2, ["초대졸", "전문대"]],
  [3, ["대졸", "대학교", "학사"]],
  [4, ["석사"]],
  [5, ["박사"]],
];

/** 판정 실패한 원문. 실행 끝에 출력 → EDU_LEVELS 를 늘리는 근거로 쓴다. */
export const UNKNOWN_EDU = new Set<string>();

/** 고졸이 지원 가능한 공고인가. 모르면 false(보수적). */
export function hsOk(edu: string | null | undefined): boolean {
  const s = edu?.trim();
  if (!s) return false;
  const ranks = EDU_LEVELS.filter(([, kws]) => kws.some((k) => s.includes(k))).map(([r]) => r);
  if (ranks.length === 0) {
    UNKNOWN_EDU.add(s);
    return false;
  }
  return Math.min(...ranks) <= 1;
}

/** 유닉스 epoch(초) / YYYY-MM-DD[ HH:MM:SS] / YYYYMMDD → Date. 못 읽으면 null. */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(s) ??
    /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y = "", mo = "", d = "", h = "0", mi = "0", se = "0"] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  // Date.UTC 는 2026-02-30 을 3/2 로 굴려버린다. 되돌려 확인해서 거른다.
  return dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d ? dt : null;
}

export type Job = {
  source: string;
  source_id: string;
  title: string;
  company: string;
  biz_no: string | null;
  region: string | null;
  edu_min: string | null;
  hs_ok: boolean;
  salary: string | null;
  url: string;
  posted_at: Date | null;
  closes_at: Date | null;
  raw: unknown;
};

const nz = (s: string | undefined | null): string | null => s?.trim() || null;

// ── 사람인 (파라미터는 공식 가이드 확인함) ─────────────────────────────
const SARAMIN_URL = "https://oapi.saramin.co.kr/job-search";

type SaraminJob = {
  id?: string | number;
  url?: string;
  company?: { detail?: { name?: string } };
  position?: {
    title?: string;
    location?: { name?: string };
    "required-education-level"?: { name?: string };
  };
  salary?: { name?: string };
  "posting-timestamp"?: string;
  "expiration-timestamp"?: string;
};

async function fetchSaramin(key: string, page: number, count = 110): Promise<unknown[]> {
  const u = new URL(SARAMIN_URL);
  u.searchParams.set("access-key", key);
  u.searchParams.set("start", String(page));
  u.searchParams.set("count", String(count));
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`사람인 ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { jobs?: { job?: unknown } };
  const jobs = body.jobs?.job ?? [];
  return Array.isArray(jobs) ? jobs : [jobs];
}

function normSaramin(raw: unknown): Job {
  const j = raw as SaraminJob;
  const pos = j.position ?? {};
  const edu = nz(pos["required-education-level"]?.name);
  return {
    source: "saramin",
    source_id: String(j.id ?? ""),
    title: pos.title?.trim() ?? "",
    company: j.company?.detail?.name?.trim() ?? "",
    biz_no: null, // 사람인은 사업자번호를 안 준다 → 상호명 매칭 폴백 (오탐 0건 정책상 unknown 유지)
    region: nz(pos.location?.name),
    edu_min: edu,
    hs_ok: hsOk(edu),
    salary: nz(j.salary?.name),
    url: j.url ?? "",
    posted_at: toDate(j["posting-timestamp"]),
    closes_at: toDate(j["expiration-timestamp"]),
    raw,
  };
}

type Source = {
  fetch: (key: string, page: number) => Promise<unknown[]>;
  norm: (raw: unknown) => Job;
  env: string;
};

// 워크넷 어댑터는 로드맵에서 제외되어 이식하지 않았다 (git 히스토리 55e7b39 에 남아있음).
// 다음은 병역일터 채용공고 API — apis.data.go.kr/1300000/CyJeongBo/list
export const SOURCES: Record<string, Source> = {
  saramin: { fetch: fetchSaramin, norm: normSaramin, env: "SARAMIN_ACCESS_KEY" },
};

// ── 적재 ──────────────────────────────────────────────────────────────
const UPSERT = `
INSERT INTO jobs (source, source_id, title, company, biz_no, region, edu_min,
                  hs_ok, salary, url, posted_at, closes_at, raw)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (source, source_id) DO UPDATE SET
  title = EXCLUDED.title, company = EXCLUDED.company, region = EXCLUDED.region,
  edu_min = EXCLUDED.edu_min, hs_ok = EXCLUDED.hs_ok, salary = EXCLUDED.salary,
  url = EXCLUDED.url, closes_at = EXCLUDED.closes_at, raw = EXCLUDED.raw,
  collected_at = now()`;

export async function upsert(rows: Job[]): Promise<number> {
  const { Client } = await import("pg"); // 지연 임포트 — --selftest 는 의존성 없이 돈다
  const c = new Client({ connectionString: process.env["DATABASE_URL"] });
  await c.connect();
  try {
    const keep = rows.filter((r) => r.source_id && r.url);
    for (const r of keep) {
      await c.query(UPSERT, [
        r.source, r.source_id, r.title, r.company, r.biz_no, r.region, r.edu_min,
        r.hs_ok, r.salary, r.url, r.posted_at, r.closes_at, JSON.stringify(r.raw),
      ]);
    }
    return keep.length;
  } finally {
    await c.end();
  }
}

// ── 자체 검증 (node_modules 0, DB 0, 네트워크 0) ───────────────────────
export function selftest(): void {
  const cases: [string | null, boolean][] = [
    ["학력무관", true], ["학력 관계없음", true], ["고졸", true],
    ["고졸 이상", true], ["고졸~대졸", true], ["중졸이상", true],
    ["초대졸 이상", false], ["전문대졸", false], ["대졸(4년)", false],
    ["대졸 이상", false], ["석사", false], ["박사 이상", false],
    ["", false], [null, false], ["   ", false],
  ];
  for (const [edu, want] of cases) {
    assert.equal(hsOk(edu), want, `hsOk(${JSON.stringify(edu)})`);
  }
  assert.ok(!UNKNOWN_EDU.has("쓰레기값"));
  assert.equal(hsOk("쓰레기값"), false);
  assert.ok(UNKNOWN_EDU.has("쓰레기값"), "미판정 원문 수집 실패");

  assert.equal(toDate("1757260800")?.toISOString(), "2025-09-07T16:00:00.000Z");
  assert.equal(toDate("2026-09-08")?.getUTCFullYear(), 2026);
  assert.equal(toDate("20260908")?.getUTCMonth(), 8);
  assert.equal(toDate("2026-09-08 13:05:00")?.getUTCHours(), 13);
  for (const bad of ["", null, "없음", "2026-02-30", "2026-13-01"]) {
    assert.equal(toDate(bad), null, `toDate(${JSON.stringify(bad)}) 는 null 이어야`);
  }

  const j = normSaramin({
    id: 123, url: "https://x",
    company: { detail: { name: "테스트㈜" } },
    position: {
      title: "백엔드 개발자", location: { name: "대전" },
      "required-education-level": { name: "고졸이상" },
    },
    salary: { name: "면접후결정" },
    "expiration-timestamp": "1757260800",
  });
  assert.equal(j.hs_ok, true);
  assert.deepEqual([j.source_id, j.company, j.region], ["123", "테스트㈜", "대전"]);
  assert.equal(normSaramin({ id: 1, url: "u" }).hs_ok, false, "빈 공고에서 터지면 안 됨");

  console.log(`selftest ok — 학력 ${cases.length}케이스 + 날짜 + 사람인 정규화`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      pages: { type: "string", default: "1" },
      probe: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      selftest: { type: "boolean", default: false },
    },
  });

  if (values.selftest) {
    selftest();
    return 0;
  }

  const name = values.probe ?? values.source;
  if (!name) {
    console.error("--source / --probe / --selftest 중 하나는 필요");
    return 1;
  }
  const src = SOURCES[name];
  if (!src) {
    console.error(`알 수 없는 소스: ${name} (가능: ${Object.keys(SOURCES).join(", ")})`);
    return 1;
  }
  const key = process.env[src.env];
  if (!key) {
    console.error(`${src.env} 가 비어 있음 (.env.example 참고)`);
    return 1;
  }

  if (values.probe) {
    const raw = await src.fetch(key, 1);
    const first = raw[0];
    if (!first) {
      console.error("응답에 공고가 없음. 파라미터부터 확인.");
      return 1;
    }
    console.log(JSON.stringify(first, null, 2));
    console.error(`\n필드 ${Object.keys(first).length}개. 위 키를 보고 정규화 함수를 맞출 것.`);
    return 0;
  }

  const rows: Job[] = [];
  for (let page = 1; page <= Number(values.pages); page++) {
    const batch = await src.fetch(key, page);
    if (batch.length === 0) break;
    rows.push(...batch.map(src.norm));
    console.error(`  page ${page}: ${batch.length}건`);
  }

  const hs = rows.filter((r) => r.hs_ok).length;
  console.log(
    rows.length
      ? `${name}: ${rows.length}건 수집, 고졸가능 ${hs}건 (${Math.round((hs / rows.length) * 100)}%)`
      : `${name}: 0건`,
  );
  if (UNKNOWN_EDU.size) {
    console.error(`⚠ 학력 미판정 ${UNKNOWN_EDU.size}종 → EDU_LEVELS 에 추가할 것:`);
    for (const e of [...UNKNOWN_EDU].sort().slice(0, 20)) console.error(`    ${e}`);
  }
  if (values["dry-run"] || rows.length === 0) return 0;
  console.log(`jobs 테이블에 ${await upsert(rows)}건 upsert`);
  return 0;
}

if (import.meta.main) process.exit(await main());
