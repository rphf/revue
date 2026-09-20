#!/usr/bin/env bash
# Prints release notes in markdown from the Conventional Commits since
# the last v* tag (docs/releasing.md), grouped by type, each line linked
# to its commit, with a compare link at the end. The Release workflow
# feeds the output to gh release create; make release-notes previews it.
#
# usage: release-notes.sh [tag] [--to <ref>]
# Without a tag, the next one comes from next-version.sh. --to names the
# commit the release is cut from, HEAD by default; the notes then cover
# everything after the newest earlier tag. Pass an existing tag to both
# to reprint the notes of a past release.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
next=""
to="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      [ $# -ge 2 ] || { echo "usage: $0 [tag] [--to <ref>]" >&2; exit 2; }
      to="$2"; shift 2 ;;
    -*)
      echo "usage: $0 [tag] [--to <ref>]" >&2; exit 2 ;;
    *)
      next="$1"; shift ;;
  esac
done
if [ -z "$next" ]; then
  next="$(bash "$here/next-version.sh")"
fi

# The newest tag strictly before the release commit, so a commit that
# already carries its tag still reports the release that ends there.
last="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$to^" 2>/dev/null || true)"
if [ -n "$last" ]; then
  range="$last..$to"
else
  range="$to"
fi

# Repository URL for commit and compare links: the Actions environment
# when present, the origin remote otherwise, nothing when neither fits.
repo_url=""
if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  repo_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
else
  origin="$(git remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    git@*:*) host_path="${origin#git@}"; repo_url="https://${host_path/://}" ;;
    ssh://git@*) repo_url="https://${origin#ssh://git@}" ;;
    https://*) repo_url="$origin" ;;
  esac
  repo_url="${repo_url%.git}"
fi

link() {
  local hash="$1"
  if [ -n "$repo_url" ]; then
    printf '[`%s`](%s/commit/%s)' "$hash" "$repo_url" "$hash"
  else
    printf '`%s`' "$hash"
  fi
}

types='build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
subject_re="^($types)(\([^)]*\))?(!)?: (.*)$"

breaking=()
feat=()
fix=()
perf=()
refactor=()
docs=()
maint=()
revert=()
other=()

while IFS= read -r line; do
  [ -n "$line" ] || continue
  hash="${line%% *}"
  subject="${line#* }"
  case "$subject" in "Merge "*) continue ;; esac
  if [[ ! "$subject" =~ $subject_re ]]; then
    other+=("- $subject ($(link "$hash"))")
    continue
  fi
  type="${BASH_REMATCH[1]}"
  bang="${BASH_REMATCH[3]}"
  summary="${BASH_REMATCH[4]}"
  item="- $summary ($(link "$hash"))"
  footer="$(git log -1 --format=%B "$hash" | sed -n 's/^BREAKING CHANGE: *//p' | head -1)"
  # A breaking change is listed once, under its own heading, with the
  # footer's explanation when the commit has one.
  if [ -n "$bang" ] || [ -n "$footer" ]; then
    if [ -n "$footer" ]; then
      breaking+=("- $summary: $footer ($(link "$hash"))")
    else
      breaking+=("$item")
    fi
    continue
  fi
  case "$type" in
    feat) feat+=("$item") ;;
    fix) fix+=("$item") ;;
    perf) perf+=("$item") ;;
    refactor) refactor+=("$item") ;;
    docs) docs+=("$item") ;;
    revert) revert+=("$item") ;;
    *) maint+=("$item") ;;
  esac
done < <(git log --format='%h %s' "$range")

section() {
  local title="$1"; shift
  [ $# -gt 0 ] || return 0
  printf '## %s\n\n' "$title"
  printf '%s\n' "$@"
  printf '\n'
}

section "Breaking changes" "${breaking[@]+"${breaking[@]}"}"
section "Features" "${feat[@]+"${feat[@]}"}"
section "Fixes" "${fix[@]+"${fix[@]}"}"
section "Performance" "${perf[@]+"${perf[@]}"}"
section "Refactoring" "${refactor[@]+"${refactor[@]}"}"
section "Documentation" "${docs[@]+"${docs[@]}"}"
section "Maintenance" "${maint[@]+"${maint[@]}"}"
section "Reverts" "${revert[@]+"${revert[@]}"}"
section "Other changes" "${other[@]+"${other[@]}"}"

if [ -n "$repo_url" ]; then
  if [ -n "$last" ]; then
    printf '**Full changelog**: %s/compare/%s...%s\n' "$repo_url" "$last" "$next"
  else
    printf '**Full changelog**: %s/commits/%s\n' "$repo_url" "$next"
  fi
fi
