# syntax=docker/dockerfile:1.7
# Agent image for revue: the project toolchain, then the generic agentbox layer. revue names its Go, Node and
# golangci-lint versions only in mise.toml (its CI installs them with mise too), so this image installs mise and
# lets the bootstrap run `mise install` from the repo's own mise.toml — no version is named here. Built by
# `agentbox build`, see README.md.
# mise (github.com/jdx/mise) as a static binary from its official image; the bootstrap uses it to materialise the
# toolchain. Declared before FROM so the pinned tag can come from an ARG in the stage reference below.
ARG MISE_VERSION=2026.9.12
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise

FROM debian:bookworm-slim

# Same pin as mcp.json in this folder: the generic layer installs this Playwright MCP and warms its npx cache.
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG TZ=Europe/Paris
ENV DEBIAN_FRONTEND=noninteractive TZ=${TZ} LANG=C.UTF-8

# build-essential: the Go race detector and any cgo `go install` want a C toolchain (revue itself is cgo-free).
# ca-certificates/tzdata: TLS and the timezone for the slim base. The generic layer installs the rest (git, curl…).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

# Generic agentbox layer: user agent, Node (global, for Claude Code), Claude Code, Playwright MCP + browsers, gh,
# net-log, a revue release build (the fallback until `make build`), shims, git config for the bot identity.
RUN --mount=type=bind,from=agentbox,target=/agentbox /agentbox/install.sh

# The harness bootstrap and the control panel are Python stdlib scripts; the slim base ships no python3.
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

# Let the agent add the web e2e chromium revision next to the baked-in MCP browsers (the container is disposable).
RUN chown -R agent:agent /opt/ms-playwright

# /workspace/bin first, so `revue` resolves to the agent's freshly built binary once `make build` has run — the
# human then reviews the change in a revue that includes it; it falls back to the release build before then. The
# mise shims put the mise.toml versions of go, node, npm and golangci-lint on PATH for every process in the box.
ENV MISE_DATA_DIR=/home/agent/.local/share/mise \
    PATH=/workspace/bin:/home/agent/.local/share/mise/shims:${PATH}

COPY --chmod=755 bootstrap /usr/local/bin/agentbox-project-bootstrap

USER agent
WORKDIR /workspace
# Warm the npx cache so .mcp.json's `npx @playwright/mcp@…` needs no download on first use.
RUN npx -y "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" --version >/dev/null 2>&1 || true
CMD ["sleep", "infinity"]
