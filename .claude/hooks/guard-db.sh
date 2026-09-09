#!/usr/bin/env bash
# PreToolUse(Bash): docker 볼륨 삭제 차단.
# 존재 이유: `down -v` 는 수집한 공고를 전부 날린다. 스키마 변경 때 두 번 썼는데
# 그때는 0건이라 안전했을 뿐이다. 데이터가 쌓인 뒤엔 복구 불가.
set -uo pipefail
cmd=$(jq -r '.tool_input.command // empty')

if printf '%s' "$cmd" | grep -Eq 'docker([ -]compose)?.*\bdown\b.*(-v|--volumes)'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "docker 볼륨 삭제는 수집한 공고를 전부 날립니다. 스키마만 바꾸려면 ALTER TABLE 을 쓰고, 정말 초기화해야 하면 먼저 `SELECT count(*) FROM jobs` 로 건수를 확인한 뒤 사용자에게 확인받으세요."
    }
  }'
  exit 0
fi
exit 0
