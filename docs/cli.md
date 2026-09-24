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
| `revue [open] [git-diff args]` | Open the browser on that diff and print the login link. When a tab is already open on that diff, no new tab opens: that tab shows a notification that brings it forward (the page asks for the permission the first time). `--no-browser` only prints. A bad argument fails here, with git's message. An empty diff opens as "No changes". |
| `revue url` | Print a login link for the default diff. |
| `revue serve` | Run the server in the foreground, as the entry point of a container or a service. On a laptop nobody types it: every other command starts the server in the background, and it stops after 30 minutes idle. |
| `revue servers [--json]` | List the running servers, one per repository, with the repository, port, PID, and URL. It starts no server. |
| `revue stop [--all]` | Stop the server of the repository you are in. Each repository has its own server, so `--all` also stops the ones for your other repositories: everything `revue servers` lists. When no server is running, it says so and exits 0. A stopped server keeps its port and token, so open tabs work again once any command starts it. |
| `revue update [--check] [--force]` | Replace the running binary with the latest release, then restart the running servers on it with the same port and token. It works wherever the binary is, including behind a symlink. It downloads the archive for this platform, checks it against `checksums.txt`, runs it once, and renames it over the old binary, so any failure leaves the old binary in place. `--check` only prints the current and latest versions. A local build (`dev`, `-dirty`, or commits past a tag) is replaced only with `--force`, which also reinstalls the current version. It exits 1 when it cannot download or write, for example when the binary's directory belongs to another user. |
| `revue prune [--dry-run]` | Remove the data and state of repositories that no longer exist. A directory whose database does not record its repository (from before this command existed) is listed and kept, and so is one whose server still runs. `--dry-run` lists what would go. It starts no server. |
| `revue version` | Print the version. |

## Agent commands

Agent commands print JSON on stdout, except `export`, which prints markdown.

| Command | Effect |
| --- | --- |
| `revue feedback [--since C]` | Every unresolved thread of the current branch with its sent comments and the code it was written on, the reviewer's last send with its note, and the events after cursor C. The output carries the new `cursor`, and `landed`: the ids of threads whose code was committed but that are not archived yet. |
| `revue reply --thread N -m TEXT` | Reply in a thread. Reads stdin when `-m` is absent. |
| `revue wait [--since C] [--timeout D]` | Block until the reviewer sends comments. The default timeout is 5m. |
| `revue export` | Print the threads as markdown, grouped by file, with quoted code and every sent comment. Drafts are excluded. |
| `revue archive --thread N [--thread M]` | Archive these threads. |
| `revue archive --landed \| --resolved \| --all` | Archive the threads of the current branch whose code landed, the resolved and outdated ones, or all of them. Exactly one selector. The output lists the `archived` ids and the `skipped` ones: a thread holding a reviewer draft is never archived. |
| `revue unarchive --thread N` | Bring an archived thread back. It stays: it does not land again. |

Threads belong to the branch they were written on, not to a diff. On a
detached HEAD, a thread belongs to every checkout that contains the commit it
was written on. Threads from before revue recorded this show on every branch.
`feedback` quotes the code each thread was written on, so the agent never
needs to look at the diff to know what a comment refers to. A thread with
`"line": 0` is about the file as a whole: it has no quote, and it stays live
while the file is in the diff.

A thread lands when its code is committed: HEAD moved past the commit it was
written on and its hunk is gone from the diff. A thread written on a range
such as `main...HEAD` lands when its branch is merged into the default branch,
or deleted. The reviewer's page offers to archive what landed, once per
commit, or archives it at once when the reviewer turned that on. Archived
threads leave `feedback` and the page's lists, and stay in the page's History,
under the commit they landed in, for 90 days (`REVUE_ARCHIVE_RETENTION`).

## Exit codes

Exit codes are stable across releases:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad arguments or invalid request |
| 3 | `wait` timed out |
