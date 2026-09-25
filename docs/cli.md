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

Agent commands print plain text, compact for an agent to read, and nothing on
success when there is nothing to say. An error is one line on stderr; the exit
code says what kind. `revue help` prints the same reference.

| Command | Effect |
| --- | --- |
| `revue feedback [--since C]` | What the agent has to act on. Without `--since`: every unresolved thread of the current branch and the last send's note. With it: only the threads the reviewer sent or reopened after cursor C, the note of a send after C, and the threads resolved after C. |
| `revue wait [--since C] [--timeout D]` | Block until the reviewer sends after C, then print what `feedback --since C` would. On timeout (5m by default) it prints the cursor and `timeout`, and exits 3. |
| `revue reply ID [TEXT]` | Answer thread ID. TEXT is GitHub-flavored markdown; without it, stdin is read, which suits several lines. |
| `revue comment PATH[:LINE[-END]] [TEXT] [--old] [-- GIT-DIFF-ARGS]` | Open a thread, published at once, and print its ID: to explain a change before the reviewer reads it. No LINE comments on the whole file; `--old` points at the old side. The thread is anchored in the working-tree diff, or in the one the arguments after `--` name, as for `revue open`. It lands in the reviewer's "Your turn". |
| `revue archive ID... \| --landed \| --resolved \| --all` | Archive these threads, or those of the current branch whose code landed, the resolved and outdated ones, or all of them. Prints `archived: ID...`, and `skipped (holds a draft): ID...` for threads with a reviewer draft, which are never archived. |
| `revue unarchive ID` | Bring an archived thread back. It stays: it does not land again. |
| `revue export` | Print every thread as markdown, grouped by file, with quoted code and every sent comment, for a human to read or paste. Drafts are excluded. |

`feedback` and `wait` print:

```text
cursor 69
note: one fix, then commit

#20 docs/agent-loop.md:18-20 outdated
  | the code as it was
  | when the reviewer commented
reviewer: can this be shorter?
agent: done
  a second line of the same comment

resolved: 19
landed: 12 14
```

Pass the cursor as `--since` next time. A thread header is `#ID PATH`, with
`:LINE` or `:START-END` unless the thread is on the whole file, then `old`
for a line of the old side and `outdated` when the code changed since the
comment. The quoted lines are the code the comment was written on, so the
agent never needs the diff to know what it refers to. Comments follow in
order; every line after the first of a text is indented by two spaces, so
anything at column 0 starts an item. `landed` lists threads whose code was
committed but that are not archived yet.

Threads belong to the branch they were written on, not to a diff. On a
detached HEAD, a thread belongs to every checkout that contains the commit it
was written on. Threads from before revue recorded this belong to no branch,
so no list shows them; `archive ID` and `unarchive ID` still reach them.
A thread on the whole file has no quote, and it stays live while the file is
in the diff.

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
