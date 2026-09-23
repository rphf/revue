# CLI reference

`revue open` shows a diff in the browser. It takes the same arguments as
`git diff`, and the page follows the working tree as files change:

```sh
revue                         # working tree against HEAD, untracked files included
revue open -- web docs        # the same, limited to paths under web/ and docs/
revue open --staged           # index
revue open main               # working tree against main
revue open main...HEAD        # this branch against its merge base with main
revue open abc123 def456      # two commits
```

## Human commands

| Command | Effect |
| --- | --- |
| `revue [open] [git-diff args]` | Open the browser on that diff and print the login link. `--no-browser` only prints. A bad argument fails here, with git's message. An empty diff opens as "No changes". |
| `revue url` | Print a login link for the default diff. |
| `revue serve` | Run the server in the foreground, as the entry point of a container or a service. On a laptop nobody types it: every other command starts the server in the background, and it stops after 30 minutes idle. |
| `revue servers [--json]` | List the running servers, one per repository, with the repository, port, PID, and URL. It starts no server. |
| `revue stop [--all]` | Stop the server of the repository you are in. Each repository has its own server, so `--all` also stops the ones for your other repositories: everything `revue servers` lists. When no server is running, it says so and exits 0. A stopped server keeps its port and token, so open tabs work again once any command starts it. |
| `revue version` | Print the version. |

## Agent commands

Agent commands print JSON on stdout, except `export`, which prints markdown.

| Command | Effect |
| --- | --- |
| `revue feedback [--since C]` | Every unresolved thread with its sent comments and the code it was written on, the reviewer's last send with its note, and the events after cursor C. The output carries the new `cursor`. |
| `revue reply --thread N -m TEXT` | Reply in a thread. Reads stdin when `-m` is absent. |
| `revue wait [--since C] [--timeout D]` | Block until the reviewer sends comments. The default timeout is 5m. |
| `revue export` | Print the threads as markdown, grouped by file, with quoted code and every sent comment. Drafts are excluded. |

Threads belong to the repository, not to a diff. `feedback` quotes the code
each thread was written on, so the agent never needs to look at the diff to
know what a comment refers to.

## Exit codes

Exit codes are stable across releases:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad arguments or invalid request |
| 3 | `wait` timed out |
