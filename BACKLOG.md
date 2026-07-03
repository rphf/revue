# Backlog

Ideas deliberately kept out of v1. The plan's Scope Boundaries section (docs/plans/2026-07-03-001-feat-revue-local-code-review-plan.md) holds the authoritative deferral list; this file collects looser ideas worth revisiting.

## Keyboard-shortcut navigation

GitHub-style review driving from the keyboard: `j`/`k` next/previous change, `n`/`p` next/previous file, `c` open comment form on the focused line, `x` toggle viewed, `Cmd+Enter` submit review. Decided out of v1 (2026-07-03) to keep the first release mouse-driven and small; design the DOM/focus structure with this in mind rather than retrofitting.

## Parking space

Add future ideas below with a date and a one-line why.

## Deferred implementation units (2026-07-03)

Deferred by Raphael mid-implementation to prioritize the e2e suite (U13). The
plan (docs/plans/2026-07-03-001-feat-revue-local-code-review-plan.md) remains
the authority for their content.

- **U10 — git-spice stack integration** (`internal/spice/`, `StackNav.tsx`).
  Groundwork: the installed binary is `git-spice` (no `gs` alias); detect both
  names. Real `gs log short --all --json` NDJSON from git-spice 0.30.1:
  `{"name":"feat1","current":true,"down":{"name":"main"},"ups":[{"name":"feat2"}]}`
  (trunk appears with `ups` only; `current` present only on the checked-out
  branch). Per-branch review args: `down...branch` (three-dot), so restacks
  recompute the merge-base per round and AE1 holds.
- **U11 — markdown export** (`internal/export/`, `GET /api/reviews/{id}/export`).
  The CLI `revue export` command already exists (U7) and errors until the
  endpoint lands.
- **U12 — release pipeline and docs** (goreleaser, release workflow, full
  README). Environment notes: clear `GOFLAGS` (user env sets `-mod=vendor`);
  npm installs are date-pinned (`before=2026-06-26`). Committing the built web
  dist for `go install` support was planned as part of this unit.
