#!/usr/bin/env bash
# PostToolUse(Edit|Write): src/**/*.ts 가 바뀌면 타입검사 + selftest.
# 존재 이유: Node 는 타입을 "검사"가 아니라 "제거"만 한다. tsc 를 안 돌리면
# 타입 오류가 런타임에 터질 때까지 완전히 안 보인다.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 0

f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
case "$f" in
  */src/*.ts) ;;
  *) exit 0 ;;
esac

out=$(npx tsc --noEmit 2>&1) || {
  jq -n --arg r "타입 오류 (Node 는 타입을 제거만 하므로 런타임엔 안 잡힘):"$'\n'"$out" \
     '{decision:"block", reason:$r}'
  exit 0
}
out=$(node src/pipeline/collect.ts --selftest 2>&1) || {
  jq -n --arg r "selftest 실패:"$'\n'"$out" '{decision:"block", reason:$r}'
  exit 0
}
exit 0
