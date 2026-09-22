# revue agentbox setup

Per-project config for running revue in an [agentbox](https://github.com/rphf/agentbox) sandbox: one throwaway
container per coding agent, with revue's toolchain, the Playwright MCP, and the control panel.

## Files

| File          | Role |
|---------------|------|
| `project.env` | `PROJECT`, `REPO_URL`, and the agent ports (`OUT_PORT`, `REVUE_PORT`). Read by the `agentbox` CLI. |
| `Dockerfile`  | The agent image: `mise` + the generic agentbox layer. Toolchain versions come from the repo's `mise.toml`, never from here. |
| `compose.yml` | Overlay on `agentbox/compose.base.yml`. Publishes the two loopback ports; revue has no services of its own. |
| `bootstrap`   | Baked in as `agentbox-project-bootstrap`, run on every `up`: `mise install`, `npm ci`, a first `make build`. |
| `AGENT.md`    | Guidance for the agent inside the box (copied to `/workspace/.agentbox/AGENT.md`, git-excluded). |
| `mcp.json`    | Playwright MCP config (copied to `/workspace/.mcp.json`, git-excluded). |

## First run

```bash
agentbox build      # build the agentbox-revue image
agentbox up 1       # start agent 1 (first up installs the toolchain + web deps + a build; a few minutes)
agentbox sh 1       # shell in; run `claude`, `make lint`, `make test`, etc.
agentbox panel 1    # open the control panel (app/revue status, links, outbox)
```

## Dogfooding the review

revue reviews itself. `/workspace/bin` is first on the container's `PATH`, so after `make build` every `revue`
command — the agent's, the panel's, `agentbox review` — runs the freshly built binary, and the human reviews each
change in a revue that already contains it. revue restarts its own server when the binary changes, keeping the port
and token, so an open review tab just needs a refresh.

## Not committed to revue

revue is a standalone tool that "does not know about agentbox or any other harness" (`CLAUDE.md`), so this whole
folder and the generated `.mcp.json` are kept out of git via `.git/info/exclude`. They live in the working tree for
the harness to read; they are not part of the revue repository.
