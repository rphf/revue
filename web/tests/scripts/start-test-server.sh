#!/usr/bin/env bash
# Playwright webServer command: builds the binary if needed, creates a
# throwaway fixture git repo and temp data dir, pins the server to a
# fixed test port + token (by pre-writing the state file the server
# reuses), seeds review #1 through the real CLI, then holds the server
# in the foreground for Playwright to manage.
set -euo pipefail

PORT="${REVUE_E2E_PORT:?REVUE_E2E_PORT not set}"
TOKEN="${REVUE_E2E_TOKEN:?REVUE_E2E_TOKEN not set}"
E2E="${REVUE_E2E_DIR:?REVUE_E2E_DIR not set}"

WEB_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(cd "$WEB_DIR/.." && pwd)"
BIN="$ROOT/bin/revue"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

rm -rf "$E2E"
mkdir -p "$E2E"
export REVUE_DATA_DIR="$E2E/data"

if [ ! -x "$BIN" ]; then
  (cd "$ROOT" && make build)
fi

# Fixture repo: two committed files, both modified in the worktree so
# the seeded review has two independent hunks (AE7 needs that).
REPO="$E2E/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email e2e@test
git -C "$REPO" config user.name e2e
cat > "$REPO/alpha.go" <<'GO'
package main

func alpha() {
	println("alpha one")
	println("alpha two")
	println("alpha three v1")
	println("alpha four")
}
GO
cat > "$REPO/beta.go" <<'GO'
package main

func beta() {
	println("beta one")
	println("beta two v1")
	println("beta three")
}
GO
git -C "$REPO" add -A
git -C "$REPO" commit -qm "base"
sed -i.bak 's/alpha three v1/alpha three v2/' "$REPO/alpha.go" && rm "$REPO/alpha.go.bak"
sed -i.bak 's/beta two v1/beta two v2/' "$REPO/beta.go" && rm "$REPO/beta.go.bak"

# Use git's canonical repo path for everything below: the CLI resolves
# the repo through git, and the data dir is keyed by that exact string.
REPO="$(git -C "$REPO" rev-parse --path-format=absolute --show-toplevel)"

# Pin port and token: the server reuses both from a recorded state
# file (KTD5), so pre-writing one fixes the test URL.
KEY="$(printf '%s' "$REPO" | shasum -a 256 | awk '{print $1}' | cut -c1-16)"
mkdir -p "$REVUE_DATA_DIR/$KEY"
printf '{"port":%s,"token":"%s","pid":0}' "$PORT" "$TOKEN" > "$REVUE_DATA_DIR/$KEY/state.json"
chmod 600 "$REVUE_DATA_DIR/$KEY/state.json"

"$BIN" serve --repo "$REPO" --idle-timeout 0 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  if curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# Seed review #1 through the real CLI (it finds the healthy server).
(cd "$REPO" && "$BIN" open --no-browser > "$E2E/seed-open.json")

echo "e2e server ready on port $PORT (review seeded)"
wait "$SERVE_PID"
