# Backlog

Ideas deliberately kept out of v1. The plan's Scope Boundaries section (docs/plans/2026-07-03-001-feat-revue-local-code-review-plan.md) holds the authoritative deferral list; this file collects looser ideas worth revisiting.

## Keyboard-shortcut navigation

GitHub-style review driving from the keyboard: `j`/`k` next/previous change, `n`/`p` next/previous file, `c` open comment form on the focused line, `x` toggle viewed, `Cmd+Enter` submit review. Decided out of v1 (2026-07-03) to keep the first release mouse-driven and small; design the DOM/focus structure with this in mind rather than retrofitting.

## Parking space

Add future ideas below with a date and a one-line why.

## PR description draft (2026-09-23)

The agent note (`revue note`) covers one round; a pull request needs a description of the
whole branch, written once the review settles. Today the agent writes it in
the chat and the human copies it out. A draft section in revue keeps it next
to the diff it describes, where the reviewer can read and comment on it.

Design sketch:

- One current draft per repository, markdown, replaced as a whole on each
  write: `revue pr-draft --file PATH` or stdin, `revue pr-draft --print` to
  read it back.
- UI: a "PR description" panel beside the threads, rendered through the
  existing `Markdown` component, with a copy button for the raw markdown.
  A new draft is an event, so the page updates live.
- The agent follows the repository's `.github/PULL_REQUEST_TEMPLATE.md` when
  there is one.
- The harness can hand the draft to `gh pr create --body-file` without the
  human copying anything.

Not decided: whether the reviewer comments on the draft as threads without a
line anchor (the agent note settled on no: the reviewer answers in a send's note), or edits it in place.

## Images in comments (2026-09-23)

A screenshot often says more than a paragraph: the reviewer shows what they
see, the agent shows what it fixed. Comments are text only today.

Design sketch:

- Paste or drop an image into the comment form. The server stores it in the
  repository's data directory and the comment body gets a markdown image link
  to `/api/uploads/<id>`, served with the same headers as `/api/asset`.
- Comments already render through DOMPurify with `img` allowed, so linked
  images display once uploads are served.
- `revue feedback` lists each comment's images with their URLs, and
  `revue upload PATH` returns a link an agent can put in a reply, so both
  sides can send images, including from a container.

Edges: a size cap per image, image types only (the `assetTypes` list), and
uploads kept while any comment links to them.

## Vim motions (2026-09-23)

Reviewing is reading, and vim users move with their fingers on the home row.
The keyboard-shortcut entry above covers GitHub's keys; this adds vim's where
they do not clash.

- Line cursor in the diff: `j`/`k` move a focused line, `gg`/`G` go to the
  top and bottom, `Ctrl-d`/`Ctrl-u` scroll half a page, `]c`/`[c` jump to the
  next and previous change, `]f`/`[f` to the next and previous file.
- `V` starts a line selection, `j`/`k` extend it, `c` comments on it, like a
  drag across the gutter.
- `/` searches file names through the tree's existing search.
- Off while a text field has focus; `Esc` leaves the comment form back to the
  line cursor.

The focused line must survive the virtualizer recycling rows, so it lives in
revue's state as a path, side, and line number, not in the DOM.

## Not planned: git-spice stack navigation (2026-09-18)

U10 (stack enumeration and per-branch navigation) is dropped for now. The
current use reviews one branch per agent, so a stack view adds little. The
plan section stays as reference if the need returns.
