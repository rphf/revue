# revue

Local code review for diffs that a coding agent wrote. The reviewer gets a
GitHub-style browser UI over anything `git diff` can express. The agent gets a
CLI to read the feedback and to reply in threads. Everything stays on one
machine: no remote, no accounts.

**Status: v0.x, the core review loop works.** git-spice stack navigation and
markdown export are not implemented (see `BACKLOG.md`).

## Install

Each release ships one archive per platform: `revue_<os>_<arch>.tar.gz` with a
single `revue` binary inside, plus `checksums.txt`. The asset names do not
change between versions, so the `latest` URL works in a Dockerfile.

```sh
# Linux (Debian names amd64 and arm64 match the archive names)
ARCH="$(dpkg --print-architecture)"
curl -fsSL "https://github.com/rphf/revue/releases/latest/download/revue_linux_${ARCH}.tar.gz" \
  | tar -xz -C /usr/local/bin revue

# macOS
ARCH="$(uname -m | sed 's/x86_64/amd64/')"
curl -fsSL "https://github.com/rphf/revue/releases/latest/download/revue_darwin_${ARCH}.tar.gz" \
  | tar -xz -C ~/.local/bin revue
```

If the repository is private for you, download with the GitHub CLI instead:
`gh release download -R rphf/revue -p 'revue_linux_arm64.tar.gz'`.

To build from source, you need Go 1.25 or newer and Node 20 or newer:

```sh
make web-install   # once
make build         # builds the web UI, embeds it, writes bin/revue
```

## Quick start

1. Go to a git repository that has changes.
2. Run `revue open`. The command captures the working-tree diff and opens the
   review in your browser.
3. Comment on lines. Comments stay drafts until you submit.
4. Submit the review with a verdict: comment, request changes, or approve.

`revue open` accepts the same arguments as `git diff`. Examples:

```sh
revue open                    # working tree, untracked files included
revue open --staged           # index
revue open main...HEAD        # this branch against its merge base with main
revue open abc123 def456      # two commits
```

## How a review works

A review is a sequence of rounds. Each round freezes the diff that was
reviewed. When the agent changes the code and signals a new round, revue
captures the same diff arguments again. Threads on hunks that did not change
stay live at their new position. Threads on hunks that changed are marked
outdated, and their history stays readable. A rebase that only moves the base
does not outdate a thread.

The reviewer resolves threads. The agent can reply but cannot resolve. After
an approval, the review is read-only for the agent until the reviewer reopens
it.

Comment bodies are markdown. Links and images render, so an agent can point at
a screenshot or a test report that it serves elsewhere.

## Commands

Human commands:

| Command | Effect |
| --- | --- |
| `revue open [git-diff args]` | Capture a diff, create a review, open the browser. `--no-browser` only prints. |
| `revue url [--review N]` | Print the browser URL of a review. Default: this branch's open review, else the review list. |
| `revue serve` | Run the per-repo server in the foreground. Other commands start it on demand. |
| `revue version` | Print the version. |

Agent commands print JSON on stdout:

| Command | Effect |
| --- | --- |
| `revue reviews` | List this repository's reviews. |
| `revue feedback [--review N] [--since C]` | Read threads, comments, and verdicts. `--since` replays only what happened after cursor C. |
| `revue reply --thread N -m TEXT` | Reply in a thread. Reads stdin when `-m` is absent. |
| `revue round [--review N]` | Signal that a new round is ready. An identical diff is a no-op with a notice. |
| `revue wait [--review N] [--since C] [--timeout D]` | Block until the reviewer submits or closes. |
| `revue export [--review N]` | Not implemented yet. |

Without `--review`, a command targets the single open review of the current
branch. When there is none, or more than one, the command says so and exits
with a distinct code.

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

## The agent loop

These steps are written for an agent. Put them in the agent's instructions.

1. Finish the change. Run the tests.
2. Run `revue open main...HEAD`. The output has a `url` and a `cursor`.
3. Give the URL to the human. Then end your turn.
4. When the human resumes you, run `revue feedback --since <cursor>`. The
   output has the verdict and every thread with quoted code.
5. If a comment needs an answer, run `revue reply --thread <id> -m "..."`.
6. If the verdict is "request changes", change the code. Then run
   `revue round`.
7. Repeat from step 3 until the verdict is "approve".

`revue wait --timeout 10m` is an alternative to step 4 for unattended runs. It
returns as soon as the reviewer submits. A submission that lands while no
`wait` is active is not lost: the next `wait` or `feedback` returns it.

## Configuration

The server reads these variables when it starts. A running server keeps its
settings until it stops. Flags of `revue serve` override them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REVUE_BIND` | `127.0.0.1` | Address the server listens on. |
| `REVUE_PORT` | recorded port, else a free port | Fixed listen port. If the port is taken, the server stops with an error. |
| `REVUE_PUBLIC_URL` | `http://127.0.0.1:<port>` | Base URL for the browser. It goes into printed links and is accepted as a request origin. |
| `REVUE_IDLE_TIMEOUT` | `30m` | Quiet period before the server stops. `0` disables the shutdown. |
| `REVUE_DATA_DIR` | XDG directories | One root for the database and the state file. For tests and scripts. |

## Run inside a container

The default settings are for a laptop. In a sandbox, the agent runs revue
inside a container and the human opens the browser outside it. Three settings
make that work:

- `REVUE_BIND=0.0.0.0`, so that the port Docker publishes reaches the server.
- `REVUE_PORT`, the same port that the container publishes.
- `REVUE_PUBLIC_URL`, the address of that port as the human's browser sees it.

Example for an agent that the host reaches at `agent1.localhost`:

```sh
REVUE_BIND=0.0.0.0
REVUE_PORT=3191
REVUE_PUBLIC_URL=http://agent1.localhost:3191
REVUE_IDLE_TIMEOUT=0
```

The security model does not change. Every request needs the token, in a header
for the CLI or in a cookie for the browser. The browser gets the token once
from the URL that `revue open` prints and exchanges it for an HttpOnly cookie.
Requests from an origin other than the loopback or the public URL are refused.
Publish the port on the host's loopback only, unless you want the server on
your network.

From the host, `revue url` run inside the container gives a fresh link. The
command also wakes the server when it stopped for inactivity.

## Data location

Each repository gets its own database and state, keyed by a hash of the
repository path. Nothing is written inside the repository.

| Path | Contents |
| --- | --- |
| `~/.local/share/revue/<key>/revue.db` | Reviews, rounds, snapshots, threads, comments |
| `~/.local/state/revue/<key>/state.json` | Port, token, and PID of the running server (mode 0600) |
| `~/.local/state/revue/<key>/server.log` | Server log |

`XDG_DATA_HOME` and `XDG_STATE_HOME` move these roots.

## Development

```sh
make build      # web UI + binary, version from git describe
make test       # go vet + go test
make web-test   # vitest
make smoke      # scripted CLI loop against the real binary
make e2e        # Playwright suite against the real binary
make release    # dist/revue_<os>_<arch>.tar.gz for darwin and linux, amd64 and arm64
```

A push of a `v*` tag builds the release archives and publishes them on GitHub
(`.github/workflows/release.yml`).

## License

MIT, see `LICENSE`.
