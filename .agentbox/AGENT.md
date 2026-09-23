# Running revue in an agentbox sandbox

Read this before deciding how to run revue or its tests here. Machine-level facts are in `~/AGENTBOX.md`, the
review protocol in `~/.claude/CLAUDE.md`; the project's own rules (review before commit, toolchain) are in `AGENTS.md` at the repo root.

## Toolchain

Go, Node and golangci-lint come from `mise` at the versions in `mise.toml`, already installed by the bootstrap, so
`go`, `node`, `npm` and `golangci-lint` are on your PATH. Do not install them any other way, and do not name a
version anywhere but `mise.toml`.

## Reviewing your change — always with the built binary

revue reviews itself, so the human's review must run the binary that has your change in it. **Rebuild before you
open or refresh a review:**

```bash
make build                             # embeds the current UI into bin/revue
revue open --no-browser main...HEAD    # or: revue url — prints the login link to hand over
```

`revue` on your PATH is `/workspace/bin/revue` once you have built it, so `make build` plus any revue command
(yours, the control panel's, `agentbox review`) serves the review from the freshly built binary. revue notices the
new build and restarts its own server on the next call, reusing the port and token, so the human just refreshes the
tab. The server answers on this sandbox's hostname and port (`REVUE_PUBLIC_URL`), which the human can open
unchanged. Never commit or push without the human's review (see `AGENTS.md`).

## Visiting the running app

The review server *is* the app. After `make build`, open a diff and drive it with the Playwright MCP:

```bash
make build
revue open --no-browser                # prints http://<host>:<REVUE_PORT>/auth?token=…
```

Navigate the MCP browser to that URL to see your UI change against the working tree. With a clean tree the diff is
empty; make an edit, or point revue at a busier range (`revue open --no-browser HEAD~5...HEAD`), to have something
to look at. Put screenshots in `~/out`, never in the repo.

## Tests and checks

```bash
make lint         # golangci-lint + gofmt, and the web typecheck/eslint/prettier
make test         # go vet + go test ./...
make web-test     # vitest (web unit tests)
make smoke        # scripted review loop against the real binary on a fixture repo
make e2e          # browser e2e in chromium (see below)
```

`make e2e` drives its own chromium through Playwright. The MCP browsers are baked in, but the web test runner pins
its own chromium revision, so install it once per container first:

```bash
cd web && npx playwright install chromium
```

## Browser work (Playwright MCP)

The Playwright MCP is configured in `.mcp.json` and runs headless chromium with the sandbox disabled (required in a
container). Use it for anything visual. The browser opens on your first browser action and holds memory until you
close it — there is no idle timeout, so `browser_close` when you finish a piece of visual work.

## Handing work back

`~/AGENTBOX.md` has the outbox, `~/.claude/CLAUDE.md` the review protocol. `.agentbox/AGENT.md` and `.mcp.json` are copied from the
human's checkout on every start and are excluded from git; they are not yours to commit.
