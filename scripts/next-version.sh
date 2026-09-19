#!/usr/bin/env bash
# Prints the next release tag from the Conventional Commits since the
# last v* tag (docs/releasing.md): a breaking change bumps the major
# (the minor while the major is 0), feat bumps the minor, anything else
# the patch. The Release workflow runs this when no tag is given.
#
# --check validates the subjects and reports what the next tag would
# be. It does not fail when nothing is new, so CI runs it on every push.
set -euo pipefail

mode=release
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac

last="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
if [ -n "$last" ]; then
  range="$last..HEAD"
  base="${last#v}"
else
  range="HEAD"
  base="0.0.0"
fi
base="${base%%-*}"
IFS=. read -r major minor patch <<< "$base"

types='build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
subject_re="^($types)(\([^)]*\))?(!)?: "
bump=none
bad=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  hash="${line%% *}"
  subject="${line#* }"
  case "$subject" in "Merge "*) continue ;; esac
  if [[ ! "$subject" =~ $subject_re ]]; then
    bad+=("$hash $subject")
    continue
  fi
  type="${BASH_REMATCH[1]}"
  bang="${BASH_REMATCH[3]}"
  if [ -n "$bang" ] || git log -1 --format=%B "$hash" | grep -q '^BREAKING CHANGE:'; then
    bump=major
  elif [ "$type" = feat ] && [ "$bump" != major ]; then
    bump=minor
  elif [ "$bump" = none ]; then
    bump=patch
  fi
done < <(git log --format='%h %s' "$range")

if [ ${#bad[@]} -gt 0 ]; then
  echo "commit subjects since ${last:-the first commit} without a Conventional Commits type:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "reword them as 'type: summary', or pass an explicit tag to the Release workflow" >&2
  exit 1
fi

if [ "$bump" = none ]; then
  if [ "$mode" = check ]; then
    echo "no commits since $last; nothing to release"
    exit 0
  fi
  echo "nothing to release: no commits since $last" >&2
  exit 1
fi

case "$bump" in
  major)
    if [ "$major" -eq 0 ]; then
      minor=$((minor + 1)); patch=0
    else
      major=$((major + 1)); minor=0; patch=0
    fi
    ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac
next="v$major.$minor.$patch"

if [ "$mode" = check ]; then
  count="$(git rev-list --count --no-merges "$range")"
  echo "next release: $next ($bump bump over ${last:-nothing}, $count commits)"
else
  echo "$next"
fi
