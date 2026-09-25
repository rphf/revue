# revue: project rules

## Review before commit, in revue itself

Never commit or push without the human's review of the exact change. The review
happens live, in revue, on the current working tree:

1. Make the change. Run `make lint` and the relevant tests.
2. Run `make build` so `bin/revue` embeds the current UI.
3. End every implementation by opening a review round and waiting on it:
   run `bin/revue open` (add `-- <paths>` to limit the diff), then
   `bin/revue wait --since C --timeout 60m`, with C the cursor from the last
   `feedback` or `wait` output. Run the wait so the harness tells you when it
   returns (a tracked background task, not a detached `&`). A CLI call from
   a newer build replaces a running server from an older one, so no manual
   restart.
4. The wait prints the comments when it returns, with the next cursor.
   Fix what they ask, rebuild, and wait again. Reply with `bin/revue reply`
   only when a comment needs an answer: a question, a choice to make, or a
   reason why you did not do something. An instruction you carried out, such
   as "commit and push", needs no reply in the thread.
5. Commit only when the human says so. Never chain a push, a tag, or a
   release after a commit in the same command.

## Standalone tool

Revue does not know about agentbox or any other harness. Code, comments,
tests, docs, and commit messages say "a sandbox", "a container", or "the
harness that runs the agent". Integration specifics live on the harness side.

## Toolchain

`mise.toml` is the only place that names a Go, Node, or golangci-lint version.
Lint and format rules are the tools' defaults with no overrides; `make lint`
must pass. Where a comment is warranted, write a short one instead of a
placeholder marker.
