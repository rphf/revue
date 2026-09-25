<img src="docs/logo.svg" alt="" width="56" height="56">

# revue

Local code review for diffs that a coding agent wrote. The reviewer gets a GitHub-style browser UI over anything `git diff` can express. The agent gets a CLI to read the feedback and to reply in threads. Everything stays on one machine: no remote, no accounts.

<img width="1580" height="1084" alt="Screenshot 2026-09-23 at 21 58 31" src="https://github.com/user-attachments/assets/3b849e93-6e7f-4768-b5d7-75a774071ce4" />

## Install

Binaries for Linux and macOS, amd64 and arm64, are on the [releases page](https://github.com/rphf/revue/releases). See [docs/install.md](docs/install.md) for download one-liners and building from source.

## Quick start

1. Go to a git repository that has changes.
2. Run `revue`. The browser opens on the working tree's diff against HEAD and follows it as files change.
3. Comment on lines. Comments stay drafts until you send them.
4. Press Send, with a note if you like. The agent reads the comments with `revue feedback`.

`revue open` accepts the same arguments as `git diff`. Examples:

```sh
revue                         # working tree against HEAD, untracked files included
revue open -- web docs        # the same, limited to paths under web/ and docs/
revue open --staged           # index
revue open main               # working tree against main
revue open main...HEAD        # this branch against its merge base with main
revue open abc123 def456      # two commits
```

## How it works

The page shows one diff, named by its `git diff` arguments, and keeps it current: while a browser is connected the server watches the repository, and the diff updates in place, the way lazygit does. A thread remembers the code it was written on. While that hunk is in the diff the thread sits on it, at its current line even when code moved above it. When the hunk changed or left the diff, the thread is outdated: it moves under its file's header, where the conversation goes on, with the file as it was and what changed in it since one click away. A file with outdated threads and no change left keeps a header of its own. A thread comes back when its code does. The threads panel groups threads by whose turn it is: yours when the agent wrote last, your drafts, the ones waiting on the agent, and the resolved ones.

Comments are drafts until you send them, all at once, with an optional note. The agent reads the send with `revue feedback` and replies in threads with `revue reply`. The agent can also open threads of its own with `revue comment`, to explain a change before you read it. The reviewer resolves threads; the agent can reply but cannot resolve.

A send also records the working tree, untracked files included, under `refs/revue/last-send`: a commit on no branch, which a plain `git push` leaves behind. The index, the working tree, and the branch stay as they are. "Since my last send" in the diff picker shows what changed after it, which is what the agent did with your comments.

Threads belong to the branch they were written on. A commit ends the conversation the way a merge does on GitHub: the threads whose code it contains land, the page offers to archive them (or does it at once, if you turn that on), and History keeps them under that commit.

Comment bodies are GitHub-flavored markdown, written in a box with Write and Preview tabs and a formatting toolbar. A newline is a line break, fenced code is highlighted by language, and tables, task lists, collapsible `<details>` sections, and GitHub alerts (`> [!NOTE]`, `> [!WARNING]`, and the like) render as on GitHub. Links and images render too, so an agent can point at a screenshot or a test report that it serves elsewhere. A markdown file in the diff has a rich view, like GitHub's: the rendered document with the changed paragraphs marked.

## Documentation

- [Install](docs/install.md): download one-liners for a shell or a Dockerfile, building from source.
- [CLI reference](docs/cli.md): every command, what a diff argument means, exit codes.
- [The agent loop](docs/agent-loop.md): the steps to put in an agent's instructions.
- [Configuration](docs/configuration.md): environment variables, running inside a container, data location.
- [Development](docs/development.md): building from source, make targets, toolchain, lint rules, CI.
- [Releasing](docs/releasing.md): tags, versions from commit types, the Release workflow.

Design notes live in `docs/plans/` and `docs/research/`.

## License

MIT, see `LICENSE`.
