# Backlog

Ideas deliberately kept out of v1. The plan's Scope Boundaries section (docs/plans/2026-07-03-001-feat-revue-local-code-review-plan.md) holds the authoritative deferral list; this file collects looser ideas worth revisiting.

## Keyboard-shortcut navigation

GitHub-style review driving from the keyboard: `j`/`k` next/previous change, `n`/`p` next/previous file, `c` open comment form on the focused line, `x` toggle viewed, `Cmd+Enter` submit review. Decided out of v1 (2026-07-03) to keep the first release mouse-driven and small; design the DOM/focus structure with this in mind rather than retrofitting.

## Parking space

Add future ideas below with a date and a one-line why.

## Agent note (2026-09-18, reworded 2026-09-20)

The page shows the diff but nothing about what the agent did or how it checked
its work. An agent that works in a sandbox typically runs tests and browser
checks, saves screenshots and reports somewhere it can serve over HTTP, and
then says the change is ready. That evidence has no home in revue today. A
short agent-written note, shown above the diff, turns the diff into a handoff:
the counterpart of the note the reviewer attaches to a send.

Design sketch, revue side:

- Schema: a `notes` table (markdown body, created_at), or one current note.
- CLI: `revue note -m TEXT`, or `--file PATH`, or stdin when `-m` is absent
  and stdin is not a terminal.
- UI: a "Note" section under the top bar, rendered through the existing
  `Markdown` component (DOMPurify keeps `img` and `a`, so a screenshot served
  from any host the reviewer's browser can reach renders inline). Collapsed
  when empty. A new note is an event, so the page picks it up live.
- Export includes the note.

Outside revue, in the instructions the agent reads (whatever harness runs it):

- The protocol: save evidence where the reviewer's browser can reach it, then
  write the note that links to it.
- A template for the note. Default sections: what changed, how it was checked
  (commands run, tests, browser checks), screenshots, known gaps or questions
  for the reviewer. If the repository has a PR template
  (`.github/PULL_REQUEST_TEMPLATE.md`), use its sections instead, so the note
  doubles as the PR description later.

Not decided: whether the reviewer can comment on the note itself as a thread
without a line anchor.

## Not planned: git-spice stack navigation (2026-09-18)

U10 (stack enumeration and per-branch navigation) is dropped for now. The
current use reviews one branch per agent, so a stack view adds little. The
plan section stays as reference if the need returns.
