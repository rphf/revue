# Development

## Build from source

Install the Go and Node versions that `mise.toml` pins. With
[mise](https://mise.jdx.dev) installed, `mise install` does it. Without mise,
install the same versions by hand.

```sh
mise install       # Go and Node, versions from mise.toml
make web-install   # once
make build         # builds the web UI, embeds it, writes bin/revue
```

## Make targets

```sh
make build         # web UI + binary, version from git describe
make test          # go vet + go test
make web-test      # vitest
make lint          # golangci-lint, gofmt check, ESLint, Prettier check
make fmt           # gofmt and Prettier, rewriting files
make smoke         # scripted CLI loop against the real binary
make e2e           # Playwright suite against the real binary
make release       # dist/revue_<os>_<arch>.tar.gz for darwin and linux, amd64 and arm64
make next-version  # the tag the next release gets, from the commits since the last tag
```

## Toolchain

`mise.toml` is the only place that names a Go, Node, or golangci-lint version.
Your shell and GitHub Actions (`jdx/mise-action`) install from it. To move to
newer versions, run `mise upgrade --bump`, then commit the changed `mise.toml`.

## Lint and format

Lint and format rules are the tools' defaults, with no project overrides:
golangci-lint's standard linters and gofmt for Go, and for the web the
recommended configs of ESLint, typescript-eslint, eslint-plugin-react-hooks and
eslint-plugin-react-refresh, with Prettier for formatting. `make lint` must
pass before a push. Inside `web/`, `npm run check` runs the type check, ESLint
and the Prettier check together; `npm run typecheck`, `npm run lint`,
`npm run format:check` and `npm run format` run one each.

The web package type-checks with TypeScript 7 (`tsc`). typescript-eslint needs
the TypeScript 6 API, which the 7.0 package does not ship, so `typescript`
resolves to the `@typescript/typescript6` shim and `@typescript/native` provides
`tsc`, as Microsoft's 7.0 announcement describes. TypeScript 7.1 is planned to
restore the API; then both entries collapse back to `typescript`.

## Web UI

The UI is React with Tailwind CSS and [shadcn](https://ui.shadcn.com)
components (Radix primitives, the neutral palette, lucide icons). The diff and
the file tree come from `@pierre/diffs` and `@pierre/trees`; their skills under
`.agents/skills/` describe the APIs the components rely on.

`web/components.json` is the shadcn configuration. Add a component with
`npx shadcn@latest add <name>` from `web/`, then run `npm run format`. The
generated files live in `web/src/components/ui/` and are ordinary source: the
react-refresh lint rule wants a module to export only components, so a
component's `cva` variants live in a sibling `*-variants.ts` file when
another module imports them.

## Continuous integration

GitHub Actions run two workflows. CI runs on every push to main and on pull
requests: `make lint`, `go vet`, `go test`, the web build with its type check,
vitest, the smoke script, the Playwright suite, and a check that every commit
subject since the last tag has a Conventional Commits type. The Release
workflow runs only when you start it; see [releasing.md](releasing.md).
