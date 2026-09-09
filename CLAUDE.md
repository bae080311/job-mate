# 고졸 취업 메이트

고졸·마이스터고 지원 가능 채용공고를 모으고 LLM으로 진로상담·포트폴리오·면접 피드백을 준다.
소프트웨어마이스터고 재학생 1인 프로젝트. 상세 기획은 Notion 문서.

## 1. 안전 규칙 — 타협 불가

**없는 병역특례를 있다고 표시하면 고등학생이 진로를 걸고 지원한다.** 일반 검색 오차와
다른 등급의 실패다. 재현율을 포기하고 정밀도를 택한다.

- `mma_status` 는 3-state: `designated` / `not_listed` / `unknown`. **boolean 으로 되돌리지 말 것** —
  "지정업체 아님"과 "확인 못 함"은 사용자에게 완전히 다른 의미다
- **상호명 매칭만으로 `designated` 로 승격 금지.** 사업자번호 일치만 확정으로 친다
  (사람인 API는 사업자번호를 주지 않으므로 사람인 공고는 대부분 `unknown` 이 정상)
- 병역일터 API 공고는 출처 자체가 병무청 지정업체 전용 포털이라 `designated` 확정
- 판정 못 하면 `unknown`. **기본값이 `unknown` 인 이유** — enrich 안 돈 공고가
  "지정업체 아님"으로 보이면 안 된다
- `hs_ok` 도 같은 원칙: 학력을 못 읽으면 `false`(보수적). 못 가는 공고를 보여주는 쪽이 더 나쁘다

## 2. 런타임

- **Node 23.6+ 네이티브 타입 스트리핑.** `node src/pipeline/collect.ts` 가 그대로 돈다.
  빌드 단계 없음 — **tsx / ts-node / 번들러를 추가하지 말 것**
- Node 는 타입을 **제거만 하고 검사하지 않는다.** 그래서 `npx tsc --noEmit` 이 유일한
  타입 안전망이다. PostToolUse 훅이 자동으로 돌린다
- `tsconfig.json` 의 `erasableSyntaxOnly` 를 끄지 말 것 — enum·namespace·parameter property 를
  쓰면 Node 가 실행을 거부한다

## 3. 의존성 — 새로 추가하기 전에 이 사다리를 밟을 것

런타임 의존성은 **`pg` 하나**다. 이미 다음으로 대체했다:

| 하고 싶은 것 | 쓰는 것 |
| --- | --- |
| HTTP 요청 | 네이티브 `fetch` + `AbortSignal.timeout()` |
| CLI 인자 파싱 | `node:util` 의 `parseArgs` |
| 테스트 | `node:assert` + `--selftest` 플래그 |
| 날짜 | `Date` + `Date.UTC` |

새 패키지를 넣기 전에: ① 정말 필요한가 ② stdlib 에 있나 ③ 이미 있는 걸로 되나.
ORM·테스트 프레임워크·HTTP 클라이언트는 이 프로젝트 규모에 과하다.

## 4. `--selftest` 는 의존성 없이 돌아야 한다

`node src/pipeline/collect.ts --selftest` 는 `node_modules` 없이도 통과해야 한다.
그래서 `pg` 만 `upsert()` 안에서 **지연 임포트**한다. 이 성질을 깨지 말 것 —
CI가 설치 전에 먼저 돌릴 수 있고, 파서 검증에 DB가 필요 없어야 한다.

파서·판정 로직을 고치면 `selftest()` 에 케이스를 **반드시** 추가한다.

## 5. 로컬 환경

- DB: `postgres://jobmate:jobmate@localhost:5434/jobmate` — **5434다.**
  5432(`eobom_postgres`)와 5433(`ax-practice-db`)은 다른 컨테이너가 쓰고 있다
- **`docker compose down -v` 금지.** 수집한 공고가 전부 날아간다. 스키마 변경은
  `ALTER TABLE`. PreToolUse 훅이 차단한다

## 6. 검증된 것 / 안 된 것

| 항목 | 상태 |
| --- | --- |
| 사람인 API 파라미터 | ✅ 공식 가이드 확인 |
| 병역일터 API 필드·이용허락 | ✅ 확인 (`cjhakryeok` = 학력) |
| 병역일터 `magamDt` 날짜 형식 | ⚠️ 명세 예시가 `"31/05/2016"` (DD/MM/YYYY) 인데 **예시가 2016년이라 명세가 낡았을 수 있음.** `--probe` 로 실측 후 `toDate` 확장 |
| 지정업체 정보 API 명세 | ⚠️ 미공개. 활용신청 후에야 필드 확인 가능 |
| 워크넷 | ❌ 로드맵 제외. Python 어댑터가 git `55e7b39` 에 있음 |

**미검증 항목을 검증된 것처럼 쓰지 말 것.** 새 API를 붙일 때는 `/new-source` 스킬을 따를 것.

## 7. Anthropic SDK (`src/llm.ts`, 2단계)

- 모델: `claude-opus-5`. eval judge 만 `claude-haiku-4-5`
- 구조화 출력: `output_config: { format: zodOutputFormat(Schema) }`
- **`res.parsed_output` 은 `null` 일 수 있다.** Python 판과 달리 raise 하지 않으므로 명시적 가드 필수
- 재시도는 `new Anthropic({ maxRetries: 4 })`. **p-retry 같은 걸 직접 짜지 말 것**
- 타임아웃 단위는 **밀리초**
- 에러 체인: `NotFoundError → RateLimitError → APIError → APIConnectionError`
  (`APIStatusError` 는 Python 전용)

## 8. 커밋

- 커밋 전 `npx tsc --noEmit` 과 `--selftest` 통과 확인 (훅이 이미 돌리지만 최종 확인)
- 커밋 메시지는 한국어. **무엇을 했는지가 아니라 왜 그렇게 했는지**를 쓴다
- GitHub 푸시는 공개 행위 — 반드시 사용자에게 먼저 확인
