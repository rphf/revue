<img src="docs/logo.svg" alt="" width="56" height="56">

# revue

Local code review for diffs that a coding agent wrote. The reviewer gets a GitHub-style browser UI over anything `git diff` can express. The agent gets a CLI to read the feedback and to reply in threads. Everything stays on one machine: no remote, no accounts.

## Install

Binaries for Linux and macOS, amd64 and arm64, are on the [releases page](https://github.com/rphf/revue/releases). See [docs/install.md](docs/install.md) for download one-liners and building from source.

## Quick start

1. Go to a git repository that has changes.
2. Run `revue open`. The command captures the working-tree diff and opens the review in your browser.
3. Comment on lines. Comments stay drafts until you submit.
4. Submit the review with a verdict: comment, request changes, or approve.

`revue open` accepts the same arguments as `git diff`. Examples:

```sh
revue open                    # working tree, untracked files included
revue open -- web docs        # the same, limited to paths under web/ and docs/
revue open --staged           # index
revue open main...HEAD        # this branch against its merge base with main
revue open abc123 def456      # two commits
```

## How a review works

A review is a sequence of rounds. Each round freezes the diff that was reviewed. When the agent changes the code and signals a new round, revue captures the same diff arguments again. Threads on hunks that did not change stay live at their new position. Threads on hunks that changed are marked outdated, and their history stays readable. A rebase that only moves the base does not outdate a thread.

The reviewer resolves threads. The agent can reply but cannot resolve. After an approval, the review is read-only for the agent until the reviewer reopens it.

Comment bodies are markdown. Links and images render, so an agent can point at a screenshot or a test report that it serves elsewhere. A markdown file in the diff has a rich view, like GitHub's: the rendered document with the changed paragraphs marked.

## Documentation

- [Install](docs/install.md): download one-liners for a shell or a Dockerfile, building from source.
- [CLI reference](docs/cli.md): every command, how a command picks its review, exit codes.
- [The agent loop](docs/agent-loop.md): the steps to put in an agent's instructions.
- [Configuration](docs/configuration.md): environment variables, running inside a container, data location.
- [Development](docs/development.md): building from source, make targets, toolchain, lint rules, CI.
- [Releasing](docs/releasing.md): tags, versions from commit types, the Release workflow.

Design notes live in `docs/plans/` and `docs/research/`.

## License

MIT, see `LICENSE`.
