# Threads on a live diff

Date: 2026-09-20. Supersedes the review, round, submission and verdict parts
of the 2026-07-03 plan. The rest of that plan (server per repo, security
model, diff rendering, drafts, resolve, event cursor) stands.

## Why

The 2026-07-03 model made every review an explicit object with frozen
rounds: `revue open` created a review, the agent signalled rounds, the
reviewer submitted with a verdict. In practice the reviewer always wants to
see the working tree as it is now, the way lazygit shows it. A change made
after `revue open` was invisible until the next round, `open` did not "open"
but "create", and the CLI carried three identifiers (review, round, cursor)
for one conversation. The rounds mostly funded one thing: showing the code a
comment was written against once that code changed. A per-thread snapshot
funds that alone.

## Decisions

- **No reviews, no rounds, no verdicts.** The unit is the thread. Threads
  belong to the repository, across branches. Resolved threads leave the
  default views.
- **The diff is computed, never stored.** The server runs `git diff <args>`
  on demand. The default is the working tree against HEAD with untracked
  files included, the same arguments `revue open` took before. While a
  browser is connected the server fingerprints the repository about once a
  second and tells the browser when the diff changed; the browser refetches
  and the diff updates in place. The arguments live in the page URL, so two
  tabs can look at two diffs.
- **A thread carries its own snapshot.** At creation the server stores the
  old and new contents of the file (content-addressed blobs, deduped), the
  hash of the hunk the comment sits in and that hunk's start line. Nothing
  else is frozen.
- **Position is derived, not stored.** For every capture the server maps
  each thread into the current hunks with the content-hash rule from the
  first plan: same hunk hash under the same or renamed path, nearest start
  wins, offset kept; a comment outside any hunk stays live while the file
  side is byte-identical. A thread that does not map is outdated for that
  view. There is no "once outdated, always outdated": an agent mid-edit
  makes hunks flicker, and a thread comes back when its code does.
- **Drafts and Send stay; the verdict goes.** Reviewer comments are drafts
  until the reviewer presses Send. Send publishes every draft at once with
  an optional note, and is the event `revue wait` returns on. The note is
  where "LGTM" or "fix these then commit" goes.
- **Old databases start over.** The schema is replaced, not migrated. The
  reviews stored by earlier versions are dropped on first start.

## CLI

```
revue [open] [git-diff args]          open the browser on that diff; --no-browser prints the URL
revue url                             print a login link for the default diff
revue serve                           run the per-repo server in the foreground
revue feedback [--since C]            unresolved threads with quoted code, plus what happened since C
revue reply --thread N -m TEXT        reply in a thread (stdin when -m is absent)
revue wait [--since C] [--timeout D]  block until the reviewer sends
revue export                          threads as markdown
revue version
```

`open` prints the URL as a plain line and validates the arguments through
the server, so a bad ref fails here and not in the browser. An empty diff is
not an error: the page shows "No changes". Agent commands print JSON.

Exit codes: 0 success, 1 unexpected error, 2 bad arguments or invalid
request, 3 `wait` timed out.

The agent loop: make the change, say it is ready (with the URL from
`revue url` when the reviewer needs one), and when resumed run
`revue feedback [--since C]`, reply with `revue reply`, fix, repeat.

## HTTP API

Diff arguments travel as a repeated `arg` query parameter:
`?arg=main...HEAD&arg=--&arg=web`. No `arg` means the default diff.

| Route | Effect |
| --- | --- |
| `GET /api/diff?arg=…` | `{args, branch, repo, version, patch, files: [{path, oldPath, status, isBinary}], anchors: [{threadId, path, side, line, startLine, state}]}`. `version` increments when the capture changes. `anchors` has one entry per thread: live ones at their current position, outdated ones at their origin. 400 `validation` for flag-shaped arguments or a ref git rejects. |
| `GET /api/diff/file?arg=…&path=P` | `{path, oldPath, status, isBinary, oldContent, newContent}` from the current capture, for context expansion and the rich markdown view. 404 when P is not in the diff. |
| `GET /api/asset?path=P` | An image from the checkout, for the rich markdown view. |
| `GET /api/threads[?drafts=1][&quote=1]` | `{threads: [{id, path, side, line, startLine, resolved, createdAt, comments, quote}]}`. |
| `POST /api/threads` | `{args, path, side, line, startLine, body}` starts a reviewer draft thread anchored in the capture for `args`. 409 `stale_diff` when P is not in that capture any more. |
| `GET /api/threads/{id}/snapshot` | `{path, oldPath, status, oldContent, newContent, createdAt}`: the file as it was when the thread started. |
| `POST /api/threads/{id}/comments` | `{role, body}`. Reviewer comments are drafts; agent comments are immediate and evented. |
| `POST /api/threads/{id}/resolve`, `…/unresolve` | Reviewer only, evented. |
| `PATCH /api/comments/{id}`, `DELETE /api/comments/{id}` | Drafts only. |
| `POST /api/send` | `{note}` publishes every draft with the note, in one transaction and one `sent` event. 400 when there is no draft and no note. |
| `GET /api/feedback?since=C` | `{cursor, events, threads, lastSend}`: events after C, unresolved threads with sent comments and a quote from their snapshot, the most recent send. |
| `GET /api/events?since=C&arg=…` | SSE. Persisted events with their id, and `{"type":"diff.changed","payload":{"version":N}}` without an id whenever the capture for `arg` changed. |
| `GET /api/wait?since=C&timeout=D` | Long-poll: `{outcome: "sent" \| "timeout", cursor, send}`. |
| `GET /api/export` | Markdown. |

Event types: `sent` (payload `{send, threads}`), `thread.replied`,
`thread.resolved`, `thread.unresolved`. Drafts never reach the log.

## Data model

```sql
blobs    (hash PK, content)
threads  (id, path, old_path, status, side, start_line, line,
          hunk_hash, hunk_start, old_blob, new_blob, resolved, created_at)
sends    (id, note, created_at)
comments (id, thread_id, author_role, body, draft, send_id, created_at)
events   (id AUTOINCREMENT, type, payload, created_at)
```

## Server

One `view` per distinct argument list, created on first use: the last
fingerprint, the capture, its hunks and renames, and a version counter. A
refresh recomputes the fingerprint (the raw `git diff` output plus the
untracked list with sizes and mtimes) at most every 500 ms and recaptures
only when it moved. The SSE handler refreshes its view once a second and
emits `diff.changed`; `GET /api/diff` refreshes before answering. Thread
positions are computed per request from the view's hunks.

## UI

One page at `/`, the diff arguments in the query string. The top bar shows
the branch and a picker for the diff (uncommitted, staged, or any
`git diff` arguments), a live indicator, the threads toggle with a count,
split or unified, the theme, and Send with the draft count. The threads
panel filters live, outdated and resolved relative to the shown diff; an
outdated thread opens its snapshot in a dialog, the file diff as it was with
the thread on it, where reply and resolve still work. A pending comment form
is kept across a diff refresh.

## Out of scope

A pause for live updates, per-branch thread scoping, an agent-written note
shown above the diff (see BACKLOG.md), converting old databases.
