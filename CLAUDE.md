# revue: project rules

## Review before commit, in revue itself

Never commit or push without Raphael's review of the exact change. The review
happens live, in revue, on the current working tree:

1. Make the change. Run `make lint` and the relevant tests.
2. Run `make build` so `bin/revue` embeds the current UI.
3. Say that the change is ready and give the command, usually
   `bin/revue open` from the repo root (add pathspecs such as `-- web` to
   leave unrelated untracked files out). A CLI call from a newer build
   replaces a running server from an older one, so no manual restart.
4. Raphael reviews and comments there. Read the feedback with
   `bin/revue feedback`, answer with `bin/revue reply`, fix, rebuild, and run
   `bin/revue open --reuse` for a new round.
5. Commit only when he says so. Never chain a push, a tag, or a release after
   a commit in the same command.

## Standalone tool

Revue does not know about agentbox or any other harness. Code, comments,
tests, docs, and commit messages say "a sandbox", "a container", or "the
harness that runs the agent". Integration specifics live on the harness side.

## Toolchain

`mise.toml` is the only place that names a Go, Node, or golangci-lint version.
Lint and format rules are the tools' defaults with no overrides; `make lint`
must pass. Where a comment is warranted, write a short one instead of a
placeholder marker.
