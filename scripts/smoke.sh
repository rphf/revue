#!/usr/bin/env bash
# Scripted end-to-end loop on a fixture repo (Verification Contract):
# open -> draft -> submit -> agent reads -> reply -> round 2 ->
# anchors recomputed. Exercises the real binary and the real server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/revue"
WORK="$(mktemp -d)"
export REVUE_DATA_DIR="$WORK/data"
export REVUE_IDLE_TIMEOUT="2m"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

FIXTURE="$WORK/repo"
SERVER_PID=""

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

json() { # json <file> <python-expr over data>
  python3 -c "import json,sys; data=json.load(open('$1')); print($2)"
}

step() { echo "--- $1"; }

[ -x "$BIN" ] || fail "bin/revue missing; run make build first"

step "fixture repo"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q -b main
git -C "$FIXTURE" config user.email smoke@test
git -C "$FIXTURE" config user.name smoke
printf 'package main\n\nfunc main() {\n\tprintln("v1")\n}\n' > "$FIXTURE/main.go"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -qm c1
printf 'package main\n\nfunc main() {\n\tprintln("v2")\n}\n' > "$FIXTURE/main.go"

step "open review (auto-starts the server)"
cd "$FIXTURE"
"$BIN" open --no-browser > "$WORK/open.json"
REVIEW_ID=$(json "$WORK/open.json" "data['review']['id']")
CURSOR=$(json "$WORK/open.json" "data['cursor']")
[ "$REVIEW_ID" -ge 1 ] || fail "no review id in open output"

STATE_FILE=$(ls "$REVUE_DATA_DIR"/*/state.json)
PORT=$(json "$STATE_FILE" "data['port']")
TOKEN=$(json "$STATE_FILE" "data['token']")
SERVER_PID=$(json "$STATE_FILE" "data['pid']")
BASE="http://127.0.0.1:$PORT"
AUTH=(-H "Authorization: Bearer $TOKEN")

step "reviewer drafts a comment and submits request_changes"
curl -sf "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"path":"main.go","side":"additions","line":4,"body":"use fmt.Println"}' \
  "$BASE/api/reviews/$REVIEW_ID/threads" > "$WORK/thread.json"
THREAD_ID=$(json "$WORK/thread.json" "data['thread']['id']")

# Drafts are invisible to the agent before submit (AE3).
"$BIN" feedback --review "$REVIEW_ID" --since "$CURSOR" > "$WORK/pre.json"
[ "$(json "$WORK/pre.json" "len(data['threads'])")" = "0" ] || fail "draft leaked before submit"

curl -sf "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"verdict":"request_changes","summary":"one fix"}' \
  "$BASE/api/reviews/$REVIEW_ID/submit" > /dev/null

step "agent reads feedback (verdict + quoted context)"
"$BIN" feedback --review "$REVIEW_ID" --since "$CURSOR" > "$WORK/fb.json"
[ "$(json "$WORK/fb.json" "data['verdict']")" = "request_changes" ] || fail "verdict missing"
[ "$(json "$WORK/fb.json" "data['threads'][0]['quote']['lines'][0]")" = '	println("v2")' ] || fail "quoted snapshot context wrong"

step "agent replies in thread"
"$BIN" reply --thread "$THREAD_ID" -m "switched to fmt.Println" > "$WORK/reply.json"
[ "$(json "$WORK/reply.json" "data['comment']['authorRole']")" = "agent" ] || fail "reply not recorded as agent"

step "agent implements the change and signals round 2"
printf 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("v2")\n}\n' > "$FIXTURE/main.go"
"$BIN" round --review "$REVIEW_ID" > "$WORK/round.json"
[ "$(json "$WORK/round.json" "data['round']['seq']")" = "2" ] || fail "round 2 not created"
[ "$(json "$WORK/round.json" "data['deduped']")" = "False" ] || fail "round 2 wrongly deduped"

step "anchors recomputed for round 2"
curl -sf "${AUTH[@]}" "$BASE/api/reviews/$REVIEW_ID/rounds/2" > "$WORK/round2.json"
[ "$(json "$WORK/round2.json" "len(data['anchors'])")" -ge 1 ] || fail "no anchors in round 2"

step "identical round signal is a no-op with notice (KTD12)"
"$BIN" round --review "$REVIEW_ID" > "$WORK/dedupe.json"
[ "$(json "$WORK/dedupe.json" "data['deduped']")" = "True" ] || fail "identical round not deduped"

step "a rebuilt binary restarts the running server on the next call"
OLD_PID="$(json "$STATE_FILE" "data['pid']")"
touch "$BIN"
"$BIN" reviews > "$WORK/reviews-after-rebuild.json" || fail "reviews after rebuild failed"
NEW_PID="$(json "$STATE_FILE" "data['pid']")"
[ "$OLD_PID" != "$NEW_PID" ] || fail "server pid unchanged after the binary changed"
[ "$(json "$WORK/reviews-after-rebuild.json" "len(data['reviews'])")" = "1" ] || fail "review list lost across the restart"
SERVER_PID="$NEW_PID"

step "wait: timeout is distinct (exit 4)"
set +e
"$BIN" wait --review "$REVIEW_ID" --since "$(json "$WORK/fb.json" "data['cursor']")" --timeout 1s > "$WORK/wait1.json"
CODE=$?
set -e
[ "$CODE" = "4" ] || fail "wait timeout exit = $CODE, want 4"

step "wait: close unblocks distinctly (exit 5, AE8)"
( sleep 0.3 && curl -sf "${AUTH[@]}" -H 'Content-Type: application/json' -d '{}' \
    "$BASE/api/reviews/$REVIEW_ID/close" > /dev/null ) &
set +e
"$BIN" wait --review "$REVIEW_ID" --since "$(json "$WORK/fb.json" "data['cursor']")" --timeout 30s > "$WORK/wait2.json"
CODE=$?
set -e
wait
[ "$CODE" = "5" ] || fail "wait close exit = $CODE, want 5"

echo "SMOKE OK"
