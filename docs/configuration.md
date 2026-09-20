# Configuration

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
| `~/.local/share/revue/<key>/revue.db` | Threads with their snapshots, comments, sends, and the event log |
| `~/.local/state/revue/<key>/state.json` | Port, token, and PID of the running server (mode 0600) |
| `~/.local/state/revue/<key>/server.log` | Server log |

`XDG_DATA_HOME` and `XDG_STATE_HOME` move these roots.
