#!/usr/bin/env bash
# Scripted end-to-end loop on a fixture repo, against the real binary
# and the real server: open -> draft -> send -> agent reads -> reply ->
# an edit on disk outdates the thread -> reverting brings it back ->
# wait.
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

# The server re-reads the repository at most twice a second; give an
# edit on disk time to be seen.
settle() { sleep 0.7; }

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

step "open prints a login link (auto-starts the server)"
cd "$FIXTURE"
URL="$("$BIN" open --no-browser)"
case "$URL" in
  http://127.0.0.1:*/auth?token=*) ;;
  *) fail "unexpected open output: $URL" ;;
esac

STATE_FILE=$(ls "$REVUE_DATA_DIR"/*/state.json)
PORT=$(json "$STATE_FILE" "data['port']")
TOKEN=$(json "$STATE_FILE" "data['token']")
SERVER_PID=$(json "$STATE_FILE" "data['pid']")
BASE="http://127.0.0.1:$PORT"
AUTH=(-H "Authorization: Bearer $TOKEN")

step "the diff is the working tree"
curl -sf "${AUTH[@]}" "$BASE/api/diff" > "$WORK/diff.json"
[ "$(json "$WORK/diff.json" "len(data['files'])")" = "1" ] || fail "expected one changed file"
[ "$(json "$WORK/diff.json" "data['files'][0]['path']")" = "main.go" ] || fail "wrong changed file"
[ "$(json "$WORK/diff.json" "data['branch']")" = "main" ] || fail "branch not reported"

step "reviewer drafts a comment; the agent cannot see it"
curl -sf "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"args":[],"path":"main.go","side":"additions","line":4,"body":"use fmt.Println"}' \
  "$BASE/api/threads" > "$WORK/thread.json"
THREAD_ID=$(json "$WORK/thread.json" "data['thread']['id']")
"$BIN" feedback > "$WORK/pre.txt"
! grep -q '^#' "$WORK/pre.txt" || fail "draft leaked before send"

step "reviewer sends with a note"
curl -sf "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"note":"one fix"}' \
  "$BASE/api/send" > /dev/null
"$BIN" feedback > "$WORK/fb.txt"
grep -qx "#$THREAD_ID main.go:4" "$WORK/fb.txt" || fail "sent thread missing"
grep -qxF '  | 	println("v2")' "$WORK/fb.txt" || fail "quoted snapshot wrong"
grep -qx "note: one fix" "$WORK/fb.txt" || fail "note missing"

step "agent replies in thread"
"$BIN" reply "$THREAD_ID" "switched to fmt.Println" || fail "reply failed"
"$BIN" feedback | grep -qx "agent: switched to fmt.Println" || fail "reply not recorded as agent"

step "an edit on disk outdates the thread; reverting brings it back"
printf 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("v2")\n}\n' > "$FIXTURE/main.go"
settle
curl -sf "${AUTH[@]}" "$BASE/api/diff" > "$WORK/diff2.json"
[ "$(json "$WORK/diff2.json" "data['anchors'][0]['state']")" = "outdated" ] || fail "thread not outdated after the edit"
printf 'package main\n\nfunc main() {\n\tprintln("v2")\n}\n' > "$FIXTURE/main.go"
settle
curl -sf "${AUTH[@]}" "$BASE/api/diff" > "$WORK/diff3.json"
[ "$(json "$WORK/diff3.json" "data['anchors'][0]['state']")" = "live" ] || fail "thread not live after the revert"

step "the snapshot keeps the file as it was"
curl -sf "${AUTH[@]}" "$BASE/api/threads/$THREAD_ID/snapshot" > "$WORK/snap.json"
[ "$(json "$WORK/snap.json" "'println(\"v2\")' in data['newContent']")" = "True" ] || fail "snapshot content wrong"

step "a rebuilt binary restarts the running server on the next call"
OLD_PID="$(json "$STATE_FILE" "data['pid']")"
touch "$BIN"
"$BIN" url > /dev/null || fail "url after rebuild failed"
NEW_PID="$(json "$STATE_FILE" "data['pid']")"
[ "$OLD_PID" != "$NEW_PID" ] || fail "server pid unchanged after the binary changed"
SERVER_PID="$NEW_PID"
curl -sf "${AUTH[@]}" "$BASE/api/threads" > "$WORK/threads.json"
[ "$(json "$WORK/threads.json" "len(data['threads'])")" = "1" ] || fail "threads lost across the restart"

step "wait: timeout is distinct (exit 3)"
set +e
"$BIN" wait --timeout 1s > "$WORK/wait1.txt"
CODE=$?
set -e
[ "$CODE" = "3" ] || fail "wait timeout exit = $CODE, want 3"

step "wait: a send unblocks (exit 0)"
( sleep 0.3 && curl -sf "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"note":"go"}' \
    "$BASE/api/send" > /dev/null ) &
set +e
"$BIN" wait --timeout 30s > "$WORK/wait2.txt"
CODE=$?
set -e
wait
[ "$CODE" = "0" ] || fail "wait send exit = $CODE, want 0"
grep -qx "note: go" "$WORK/wait2.txt" || fail "wait did not print the send"
! "$BIN" feedback | grep -q "^note:" || fail "a delivered note was printed again"

echo "SMOKE OK"
