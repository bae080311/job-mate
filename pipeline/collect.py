#!/usr/bin/env python3
"""채용공고 수집 → jobs 테이블.

  python -m pipeline.collect --selftest            # 네트워크/DB 없이 파서 검증
  python -m pipeline.collect --probe worknet       # 원본 1건 덤프 (필드명 확인용)
  python -m pipeline.collect --source saramin --pages 3
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from xml.etree import ElementTree

# ── 학력 판정 ────────────────────────────────────────────────────────
# 문자열에 등장하는 학력 키워드 중 "가장 낮은" 등급으로 판정한다.
# "초대졸"은 "대졸"에도 걸리지만 min() 이라 2로 잡힌다. 순서 의존성 없음.
EDU_LEVELS: list[tuple[int, tuple[str, ...]]] = [
    (0, ("무관", "관계없음", "제한없음")),
    (1, ("초졸", "중졸", "고교", "고졸")),
    (2, ("초대졸", "전문대")),
    (3, ("대졸", "대학교", "학사")),
    (4, ("석사",)),
    (5, ("박사",)),
]

# 판정 실패한 원문. 실행 끝에 출력 → 위 표를 늘리는 근거로 쓴다.
UNKNOWN_EDU: set[str] = set()


def hs_ok(edu: str | None) -> bool:
    """고졸이 지원 가능한 공고인가. 모르면 False(보수적)."""
    if not edu or not edu.strip():
        return False
    found = [rank for rank, kws in EDU_LEVELS if any(k in edu for k in kws)]
    if not found:
        UNKNOWN_EDU.add(edu.strip())
        return False
    return min(found) <= 1


def _ts(v) -> datetime | None:
    """유닉스 epoch(초) / YYYY-MM-DD / YYYYMMDD 를 tz-aware datetime 으로."""
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    if s.isdigit() and len(s) == 10:
        return datetime.fromtimestamp(int(s), tz=timezone.utc)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


# ── 사람인 (파라미터는 공식 가이드 확인함) ─────────────────────────────
SARAMIN_URL = "https://oapi.saramin.co.kr/job-search"


def fetch_saramin(key: str, page: int, count: int = 110) -> list[dict]:
    import httpx

    r = httpx.get(
        SARAMIN_URL,
        params={"access-key": key, "start": page, "count": count},
        timeout=20,
    )
    r.raise_for_status()
    body = r.json().get("jobs") or {}
    jobs = body.get("job") or []
    return jobs if isinstance(jobs, list) else [jobs]


def norm_saramin(j: dict) -> dict:
    pos = j.get("position") or {}
    edu = ((pos.get("required-education-level") or {}).get("name") or "").strip() or None
    return {
        "source": "saramin",
        "source_id": str(j.get("id", "")),
        "title": (pos.get("title") or "").strip(),
        "company": (((j.get("company") or {}).get("detail") or {}).get("name") or "").strip(),
        "biz_no": None,  # 사람인은 사업자번호를 안 준다 → enrich.py 에서 상호명 매칭 폴백
        "region": ((pos.get("location") or {}).get("name") or "").strip() or None,
        "edu_min": edu,
        "hs_ok": hs_ok(edu),
        "salary": ((j.get("salary") or {}).get("name") or "").strip() or None,
        "url": j.get("url") or "",
        "posted_at": _ts(j.get("posting-timestamp")),
        "closes_at": _ts(j.get("expiration-timestamp")),
        "raw": j,
    }


# ── 워크넷 ────────────────────────────────────────────────────────────
# ⚠ 아래 태그명은 미검증. `--probe worknet` 으로 실제 태그를 찍어보고 고칠 것.
WORKNET_URL = "https://openapi.work.go.kr/opi/opi/opia/wantedApi.do"
WORKNET_TAGS = {
    "source_id": "wantedAuthNo",
    "title": "title",
    "company": "company",
    "region": "region",
    "edu_min": "minEdubg",
    "salary": "sal",
    "url": "wantedInfoUrl",
    "posted_at": "regDt",
    "closes_at": "closeDt",
}


def fetch_worknet(key: str, page: int, display: int = 100) -> list[dict]:
    import httpx

    r = httpx.get(
        WORKNET_URL,
        params={
            "authKey": key,
            "callTp": "L",
            "returnType": "XML",
            "startPage": page,
            "display": display,
        },
        timeout=20,
    )
    r.raise_for_status()
    root = ElementTree.fromstring(r.text)
    return [{c.tag: (c.text or "").strip() for c in w} for w in root.iter("wanted")]


def norm_worknet(w: dict) -> dict:
    g = lambda k: (w.get(WORKNET_TAGS[k]) or "").strip() or None  # noqa: E731
    edu = g("edu_min")
    return {
        "source": "worknet",
        "source_id": g("source_id") or "",
        "title": g("title") or "",
        "company": g("company") or "",
        "biz_no": None,
        "region": g("region"),
        "edu_min": edu,
        "hs_ok": hs_ok(edu),
        "salary": g("salary"),
        "url": g("url") or "",
        "posted_at": _ts(g("posted_at")),
        "closes_at": _ts(g("closes_at")),
        "raw": w,
    }


SOURCES = {
    "saramin": (fetch_saramin, norm_saramin, "SARAMIN_ACCESS_KEY"),
    "worknet": (fetch_worknet, norm_worknet, "WORKNET_AUTH_KEY"),
}

# ── 적재 ──────────────────────────────────────────────────────────────
UPSERT = """
INSERT INTO jobs (source, source_id, title, company, biz_no, region, edu_min,
                  hs_ok, salary, url, posted_at, closes_at, raw)
VALUES (%(source)s, %(source_id)s, %(title)s, %(company)s, %(biz_no)s, %(region)s,
        %(edu_min)s, %(hs_ok)s, %(salary)s, %(url)s, %(posted_at)s, %(closes_at)s, %(raw)s)
ON CONFLICT (source, source_id) DO UPDATE SET
  title = EXCLUDED.title, company = EXCLUDED.company, region = EXCLUDED.region,
  edu_min = EXCLUDED.edu_min, hs_ok = EXCLUDED.hs_ok, salary = EXCLUDED.salary,
  url = EXCLUDED.url, closes_at = EXCLUDED.closes_at, raw = EXCLUDED.raw,
  collected_at = now()
"""


def upsert(rows: list[dict]) -> int:
    import psycopg
    from psycopg.types.json import Json

    dsn = os.environ["DATABASE_URL"]
    payload = [{**r, "raw": Json(r["raw"])} for r in rows if r["source_id"] and r["url"]]
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.executemany(UPSERT, payload)
        conn.commit()
    return len(payload)


# ── 자체 검증 (의존성 0, DB 0, 네트워크 0) ─────────────────────────────
def selftest() -> None:
    cases = [
        ("학력무관", True), ("학력 관계없음", True), ("고졸", True),
        ("고졸 이상", True), ("고졸~대졸", True), ("중졸이상", True),
        ("초대졸 이상", False), ("전문대졸", False), ("대졸(4년)", False),
        ("대졸 이상", False), ("석사", False), ("박사 이상", False),
        ("", False), (None, False), ("   ", False),
    ]
    for edu, want in cases:
        got = hs_ok(edu)
        assert got == want, f"hs_ok({edu!r}) = {got}, want {want}"
    assert "쓰레기값" not in UNKNOWN_EDU
    assert hs_ok("쓰레기값") is False and "쓰레기값" in UNKNOWN_EDU, "미판정 원문 수집 실패"

    assert _ts("1757260800") == datetime(2025, 9, 7, 16, 0, tzinfo=timezone.utc)
    assert _ts("2026-09-08").year == 2026
    assert _ts("20260908").month == 9
    assert _ts("") is None and _ts(None) is None and _ts("없음") is None

    j = norm_saramin({
        "id": 123, "url": "https://x",
        "company": {"detail": {"name": "테스트㈜"}},
        "position": {"title": "백엔드 개발자", "location": {"name": "대전"},
                     "required-education-level": {"name": "고졸이상"}},
        "salary": {"name": "면접후결정"},
        "expiration-timestamp": "1757260800",
    })
    assert j["hs_ok"] is True, j
    assert (j["source_id"], j["company"], j["region"]) == ("123", "테스트㈜", "대전"), j
    assert norm_saramin({"id": 1, "url": "u"})["hs_ok"] is False, "빈 공고에서 터지면 안 됨"

    w = norm_worknet({"wantedAuthNo": "K1", "title": "생산직", "company": "가나다",
                      "minEdubg": "대졸이상", "wantedInfoUrl": "https://y"})
    assert w["hs_ok"] is False and w["source_id"] == "K1", w

    print(f"selftest ok — 학력 {len(cases)}케이스 + 날짜 + 정규화 2소스")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", choices=sorted(SOURCES))
    p.add_argument("--pages", type=int, default=1)
    p.add_argument("--probe", choices=sorted(SOURCES), help="원본 1건만 찍고 종료")
    p.add_argument("--dry-run", action="store_true", help="DB 안 쓰고 건수만")
    p.add_argument("--selftest", action="store_true")
    a = p.parse_args()

    if a.selftest:
        selftest()
        return 0

    name = a.probe or a.source
    if not name:
        p.error("--source / --probe / --selftest 중 하나는 필요")
    fetch, norm, env = SOURCES[name]
    key = os.environ.get(env)
    if not key:
        print(f"{env} 가 비어 있음 (.env.example 참고)", file=sys.stderr)
        return 1

    if a.probe:
        raw = fetch(key, 1)
        if not raw:
            print("응답에 공고가 없음. 파라미터부터 확인.", file=sys.stderr)
            return 1
        print(json.dumps(raw[0], ensure_ascii=False, indent=2, default=str))
        print(f"\n필드 {len(raw[0])}개. 위 키를 보고 정규화 함수를 맞출 것.", file=sys.stderr)
        return 0

    rows: list[dict] = []
    for page in range(1, a.pages + 1):
        batch = fetch(key, page)
        if not batch:
            break
        rows += [norm(x) for x in batch]
        print(f"  page {page}: {len(batch)}건", file=sys.stderr)

    hs = sum(r["hs_ok"] for r in rows)
    print(f"{name}: {len(rows)}건 수집, 고졸가능 {hs}건 ({hs / len(rows):.0%})" if rows
          else f"{name}: 0건")
    if UNKNOWN_EDU:
        print(f"⚠ 학력 미판정 {len(UNKNOWN_EDU)}종 → EDU_LEVELS 에 추가할 것:", file=sys.stderr)
        for e in sorted(UNKNOWN_EDU)[:20]:
            print(f"    {e}", file=sys.stderr)
    if a.dry_run or not rows:
        return 0
    print(f"jobs 테이블에 {upsert(rows)}건 upsert")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
