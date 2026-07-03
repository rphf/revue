# revue

Local code review for AI-agent diffs: a GitHub-style browser UI over anything
`git diff` can express, with an agent-facing CLI for reading feedback and
replying in threads. Fully local — no remote, no accounts.

**Status: under construction (v1 in progress).**

## Build from source

Requires Go ≥ 1.25 and Node ≥ 20.

```sh
make web-install  # once
make build        # builds the web UI, embeds it, produces bin/revue
bin/revue         # serves on 127.0.0.1
```
