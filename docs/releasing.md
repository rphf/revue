# Releasing

A tag and a release are one step, and the Release workflow owns both. It
creates the tag on the ref you select, builds and tests the archives, and
publishes the GitHub release with notes written from the commits. Do not tag by hand:
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

## Release notes from the same commits

The notes are the commit subjects since the last tag, grouped by type, each
linked to its commit, with a compare link at the end. `make release-notes`
prints what the next release would say; `scripts/release-notes.sh v0.4.0 --to
v0.4.0` reprints the notes of a release that exists.

| Type | Section |
| --- | --- |
| `!` after the type, or a `BREAKING CHANGE:` footer | Breaking changes, with the footer text |
| `feat` | Features |
| `fix` | Fixes |
| `perf` | Performance |
| `refactor` | Refactoring |
| `docs` | Documentation |
| `build`, `ci`, `chore`, `test`, `style` | Maintenance |
| `revert` | Reverts |
| no type (only reachable with an explicit tag) | Other changes |

A subject reads as a line of the notes, so write it for the reader of the
release: what changed, not which file. GitHub's own generated notes are not
used; they list merged pull requests, and commits pushed to main directly
would leave them empty.

## Cutting a release

```sh
make next-version                          # preview, for example v0.4.0
make release-notes                         # the notes that release would get
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
