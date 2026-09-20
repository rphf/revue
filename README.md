<img src="docs/logo.svg" alt="" width="56" height="56">

# revue

Local code review for diffs that a coding agent wrote. The reviewer gets a GitHub-style browser UI over anything `git diff` can express. The agent gets a CLI to read the feedback and to reply in threads. Everything stays on one machine: no remote, no accounts.

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

The page shows one diff, named by its `git diff` arguments, and keeps it current: while a browser is connected the server watches the repository, and the diff updates in place, the way lazygit does. A thread remembers the code it was written on. While that hunk is in the diff the thread sits on it, at its current line even when code moved above it. When the hunk changed or left the diff, the thread is outdated: it stays in the threads panel and opens on the file as it was. A thread comes back when its code does.

Comments are drafts until you send them, all at once, with an optional note. The agent reads the send with `revue feedback` and replies in threads with `revue reply`. The reviewer resolves threads; the agent can reply but cannot resolve.

Comment bodies are markdown. Links and images render, so an agent can point at a screenshot or a test report that it serves elsewhere. A markdown file in the diff has a rich view, like GitHub's: the rendered document with the changed paragraphs marked.

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
