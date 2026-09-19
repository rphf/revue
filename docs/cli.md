# CLI reference

`revue open` accepts the same arguments as `git diff`:

```sh
revue open                    # working tree, untracked files included
revue open -- web docs        # the same, limited to paths under web/ and docs/
revue open --staged           # index
revue open main...HEAD        # this branch against its merge base with main
revue open abc123 def456      # two commits
```

## Human commands

| Command | Effect |
| --- | --- |
| `revue open [git-diff args]` | Capture a diff, create a review, open the browser. `--no-browser` only prints. `--reuse` adds a round to this branch's open review with the same arguments instead of creating another review. |
| `revue url [--review N]` | Print the browser URL of a review. Default: this branch's open review, else the review list. |
| `revue serve` | Run the per-repo server in the foreground. Other commands start it on demand. |
| `revue version` | Print the version. |

## Agent commands

Agent commands print JSON on stdout, except `export`, which prints markdown.

| Command | Effect |
| --- | --- |
| `revue reviews` | List this repository's reviews. |
| `revue feedback [--review N] [--since C]` | Read threads, comments, and verdicts. `--since` replays only what happened after cursor C. |
| `revue reply --thread N -m TEXT` | Reply in a thread. Reads stdin when `-m` is absent. |
| `revue round [--review N]` | Signal that a new round is ready. An identical diff is a no-op with a notice. |
| `revue wait [--review N] [--since C] [--timeout D]` | Block until the reviewer submits or closes. |
| `revue export [--review N]` | Print the review as markdown: source, verdicts by round, then threads grouped by file with quoted code and replies. Drafts are excluded. |

Without `--review`, a command targets the single open review of the current
branch. When there is none, or more than one, the command says so and exits
with a distinct code.

## Exit codes

Exit codes are stable across releases:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad arguments or invalid request |
| 3 | No open review for this branch |
| 4 | `wait` timed out |
| 5 | The review is closed |
| 6 | The review is approved and read-only for the agent |
