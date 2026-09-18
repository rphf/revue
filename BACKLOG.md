# Backlog

Ideas deliberately kept out of v1. The plan's Scope Boundaries section (docs/plans/2026-07-03-001-feat-revue-local-code-review-plan.md) holds the authoritative deferral list; this file collects looser ideas worth revisiting.

## Keyboard-shortcut navigation

GitHub-style review driving from the keyboard: `j`/`k` next/previous change, `n`/`p` next/previous file, `c` open comment form on the focused line, `x` toggle viewed, `Cmd+Enter` submit review. Decided out of v1 (2026-07-03) to keep the first release mouse-driven and small; design the DOM/focus structure with this in mind rather than retrofitting.

## Parking space

Add future ideas below with a date and a one-line why.

## Round handoff note (2026-09-18)

A review shows the diff but nothing about what the agent did or how it checked
its work. When an agent works in a sandbox (agentbox), it runs specs and
Playwright, takes screenshots into its outbox, and then opens the review. That
evidence has no home in the review today. A short agent-written note per round,
shown at the top of the review, turns the diff into a handoff.

Design sketch, revue side:

- Schema: `rounds.note TEXT NOT NULL DEFAULT ''` (markdown).
- API: `POST /api/reviews` and `POST /api/reviews/{id}/rounds` accept an
  optional `note` field. The round payload returns it. A new-round event carries
  it.
- CLI: `revue open -m TEXT` and `revue round -m TEXT`, or `--note-file PATH`,
  or stdin when `-m` is absent and stdin is not a terminal.
- UI: a "Handoff" section under the review header, rendered through the existing
  `Markdown` component (DOMPurify keeps `img` and `a`, so outbox screenshots at
  `http://agentN.localhost:<OUT_PORT>/...` render inline). The section follows
  the round switcher, so each round keeps its own note. Collapsed when empty.
- Export (U11) includes the note per round.

Agentbox side, once the revue part exists:

- `AGENTBOX.md` (harness) tells the agent the protocol: put evidence in
  `~/out`, then open the review with a note that links to it.
- The note has a template. Default sections: what changed, how it was checked
  (commands run, specs, Playwright), screenshots, known gaps or questions for
  the reviewer. If the repository has a PR template
  (`.github/PULL_REQUEST_TEMPLATE.md`), the instruction says to use its
  sections instead, so the note doubles as the PR description later.
- The project's `AGENT.md` can narrow the template (which spec lanes count as
  "checked" for this app).

Not decided: whether the note is editable by the agent after the round opens
(GitHub lets a PR body change at any time), and whether the reviewer can
comment on the note itself as a thread without a line anchor.

## Not planned: git-spice stack navigation (2026-09-18)

U10 (stack enumeration and per-branch navigation) is dropped for now. The
agentbox flow reviews one branch per agent, so a stack view adds little. The
plan section stays as reference if the need returns.

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
