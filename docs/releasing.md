# Releasing

A tag and a release are one step, and the Release workflow owns both. It
creates the tag on the ref you select, builds and tests the archives, and
publishes the GitHub release with generated notes. Do not tag by hand:
installs follow `releases/latest/download/`, so a tag without a release ships
nothing, and the workflow refuses a tag that already exists.

## Versions from commit types

Commit subjects are `type: summary`, with no scope. The next version follows
from the subjects since the last tag:

| Commits since the last tag | Bump |
| --- | --- |
| A `!` after the type, or a `BREAKING CHANGE:` footer | Major; minor while the major is 0 |
| At least one `feat:` | Minor |
| Only `fix:`, `chore:`, `docs:`, `build:`, `ci:`, `refactor:`, `test:`, `style:`, `perf:`, `revert:` | Patch |

`scripts/next-version.sh` applies these rules; `make next-version` runs it. A
subject without a type fails the CI check and the release. Reword it, or pass
an explicit tag.

## Cutting a release

```sh
make next-version                          # preview, for example v0.4.0
gh workflow run release.yml                # derive the tag and release main
gh workflow run release.yml -f tag=v1.0.0  # or choose the tag yourself
```

Release when main is green and every new container should get it: `latest`
moves as soon as the workflow finishes. Push first; the workflow releases the
ref on GitHub, not your working tree.

The tag is created on GitHub, so your clone learns about it at the next plain
`git fetch` or `git pull`; `git fetch --tags` also works. A pull with an
explicit refspec such as `git pull origin main` does not fetch it. After that,
`make build` stamps the new version, since it reads `git describe`.

## When to leave 0.x

Stay on 0.x until the CLI contract (commands, JSON shapes, exit codes) is one
you intend to keep; then tag v1.0.0 by hand once and let the rules take over.
