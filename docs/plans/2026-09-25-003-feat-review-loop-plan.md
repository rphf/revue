# A clearer review loop

Date: 2026-09-25. Builds on the 2026-09-20 live-diff plan; nothing in it is
reversed.

## Why

After a first real review of about 30 comments, the second pass was hard to
read:

- The panel grouped threads by round, that is by time. The reviewer's
  question after the agent's turn is "whose turn is it on each thread", not
  "when was it written". Agent replies sat under the previous send, and on a
  first review under "Not sent yet" with the drafts.
- A thread goes outdated when the agent rewrites the code around it, which
  is usually the sign it acted on the comment. Outdated threads leave the
  diff, so the threads that matter most after an iteration are the hardest
  to reach: one snapshot at a time.
- There is no "what changed since I last looked": each pass re-reads the
  whole diff against HEAD.
- The agent is about to open threads of its own (a self-review), which would
  make the time-based grouping worse.

The iteration stays on the working tree. Commits do not mark rounds: they
would need a history rewrite before a push.

## Decisions

1. **The panel groups threads by whose turn it is.** From the thread's last
   comment: *Your turn* (the agent wrote last, including a thread the agent
   started), *Drafts* (a comment of yours not sent yet), *Waiting on agent*
   (you wrote last and sent it), *Resolved*. Rounds are no longer a
   grouping; a thread row shows how many sends it went through. Your turn
   and Drafts are open by default, the other two collapsed. A row in Your
   turn shows the agent's last comment under the first one.
2. **Outdated threads stay in the diff.** A thread that no longer maps to a
   line is listed under its file's header, marked with the line it was on.
   Opening it shows the file as it was against the file now, so the
   reviewer sees what the agent did about it. A thread whose file left the
   diff keeps a header of its own, in tree order, marked as no longer in
   the diff. A resolved outdated thread leaves the diff. The snapshot view
   stays.
3. **A Send saves a checkpoint of the working tree, without a commit.** The
   server writes the working tree, untracked files included, as a tree
   through a temporary index file, wraps it in a commit object, and keeps it
   under `refs/revue/last-send`. Each send replaces it: the diff only ever
   needs the last one, and the page URL stays the same across sends. The
   working tree, the index, and the branch do not change; a plain
   `git push` does not send the ref.
4. **The diff can show "since my last send".** A preset of the diff picker
   runs `git diff refs/revue/last-send` on a copy of the index where
   untracked files are marked intent-to-add: `git diff <ref>` alone calls
   a file untracked at both points deleted and leaves new ones out.
   "Uncommitted changes" stays the default.
5. **The agent can open a thread.** `revue comment PATH[:LINE[-END]]
   [TEXT]` posts a published agent thread, the way `revue reply` posts a
   reply. It is anchored in the working-tree diff unless the arguments
   after `--` name another. It lands in Your turn.

History is unchanged: it serves committed work, after the loop.

## Order

Each step is reviewed on its own.

1. Panel by turn (UI only).
2. Outdated threads on their file's header, with the before and after.
3. Checkpoints on Send and the "since my last send" diff (server, store,
   UI).
4. `revue comment`.
