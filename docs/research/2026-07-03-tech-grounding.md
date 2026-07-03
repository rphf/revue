# Tech Grounding Dossier — Local Code-Review Tool

---

## 1. Pierre UI Libraries (@pierre/diffs + @pierre/trees)

### @pierre/diffs
- npm package: `@pierre/diffs` — https://www.npmjs.com/package/@pierre/diffs
- Framework: ships vanilla JS API (`@pierre/diffs`) + React components (`@pierre/diffs/react`); React 18/19 is a peer dep — https://github.com/pierrecomputer/pierre/blob/main/packages/diffs/package.json
- Renders: unified ("stacked") and split side-by-side diff views via CSS Grid + Shadow DOM — https://diffs.com/
- Syntax highlighting engine: Shiki (supports shiki ^3.0.0 || ^4.0.0 + @shikijs/transformers) — https://pierre.computer/writing/on-rendering-diffs
- Virtualization: yes — line-range rendering with binary search, element pooling, incremental DOM height measurement, "Inverse Sticky Technique" — https://pierre.computer/writing/on-rendering-diffs
- Character/word-level inline change highlighting — https://diffs.com/
- Additional components: `FileDiff`, `File` (single file, no diff), `UnresolvedFile` (merge conflicts, beta) — https://diffs.com/docs
- License: Apache-2.0 — https://github.com/pierrecomputer/pierre/blob/main/packages/diffs/package.json
- Version: 1.2.12 stable (2026-06-29); 1.3.0-beta.7 pre-release (2026-07-02) — gh api repos/pierrecomputer/pierre/releases/latest
- Stars (shared monorepo): 5,303; forks: 166; npm dependents: 157 — gh api repos/pierrecomputer/pierre
- Repo created: 2026-09-19; 75+ tagged releases — gh api repos/pierrecomputer/pierre/releases
- Docs: full site at https://diffs.com/docs — covers component API, annotations, theming, perf internals

### @pierre/diffs — Inline Comment / Annotation Support
- First-class annotation framework for injecting content below specific diff lines — https://diffs.com/
- Line selection opt-in via `enableLineSelection: true`; click selects a line, shift-click/drag for multi-line ranges — https://diffs.com/docs
- `+` button on gutter hover for quick single-line annotation entry — https://plannotator.ai/blog/local-diff-review-for-coding-agents/
- `DiffLineAnnotation` prop on `MultiFileDiff`/`PatchDiff`/`FileDiff`; `LineAnnotation` on `File` — https://diffs.com/docs
- Designed for GitHub-style inline comment threads and AI accept/reject UI — https://github.com/oorestisime/opencode-diffs
- Third-party integration confirmed: opencode-diffs (per-line structured annotations), Plannotator (interactive review) — https://github.com/oorestisime/opencode-diffs

### @pierre/trees
- npm package: `@pierre/trees` — https://www.npmjs.com/package/@pierre/trees
- Framework: ships 4 entry points — vanilla (`@pierre/trees`), React hook + component (`@pierre/trees/react`), SSR (`@pierre/trees/ssr`), web-components — https://trees.software/docs
- Internal rendering engine: Preact (abstracted from consumer) — https://github.com/pierrecomputer/pierre/blob/main/packages/trees/package.json
- Renders: file tree; virtualized for tens of thousands of items — https://trees.software/docs
- Features: keyboard nav, ARIA (WCAG 2.1), drag-and-drop, git status indicators, search, customizable icons, sticky folders, context menus — https://trees.software/docs
- Row annotations/signals exist but are visual git status decorations, not comment threads — https://trees.software/docs
- License: Apache-2.0 — https://www.jsdelivr.com/package/npm/@pierre/trees
- Version: 1.0.0-beta.5 (May 2026); explicitly labeled "in beta, expect API shifts" — https://npmx.dev/package/@pierre/trees

---

## 2. diffx

- Repo: https://github.com/wong2/diffx
- npm package: `diffx-cli` (global install: `npm install -g diffx-cli`); binary: `diffx`; port: 3433 — https://registry.npmjs.org/diffx-cli
- Latest version: v0.16.0, published 2026-06-23 — https://registry.npmjs.org/diffx-cli
- Stars: 163; forks: 27; open issues: 5; repo created: 2026-04-04; last commit: 2026-06-23 — gh api repos/wong2/diffx
- License: none specified in repo
- Diff sources: git working tree, staged, commit ranges, branch comparisons passed as `git diff` args (e.g., `diffx -- HEAD~3`) — https://raw.githubusercontent.com/wong2/diffx/main/README.md
- UI: browser-based; split/unified view; Shiki syntax highlighting; hierarchical file tree with search; image preview; viewed-file tracking; staged/untracked toggle — https://github.com/wong2/diffx
- Comment support: inline comments with line-specific markers; AI agent replies (bot avatar); open/replied/resolved status; "Copy comments" exports structured XML with code context — https://github.com/wong2/diffx
- Tech stack: TypeScript, React 19.1.0, Hono 4.7.6 (Node.js), @pierre/diffs 1.2.9, TanStack Query 5, Vite 8, tsdown — https://raw.githubusercontent.com/wong2/diffx/main/package.json

---

## 3. diffity

- Repo: https://github.com/nilbuild/diffity (author: Kamran Ahmed)
- npm package: `diffity` (global install: `npm install -g diffity`); binary: `diffity` — https://registry.npmjs.org/diffity
- Latest version: v0.9.5, published 2026-04-02 — https://registry.npmjs.org/diffity
- Stars: 703; forks: 39; open issues: 13; repo created: 2026-03-16; last commit: 2026-05-11 — gh api repos/nilbuild/diffity
- License: MIT (Copyright 2026 Kamran Ahmed) — gh api repos/nilbuild/diffity/contents/LICENSE
- Homepage: https://diffity.com
- Diff sources: uncommitted working dir, specific commits, commit ranges, branch comparisons (`diffity main..feature`), git tags, GitHub PR URLs (requires `gh` CLI), staged-only/unstaged-only — https://raw.githubusercontent.com/nilbuild/diffity/main/README.md
- UI: browser-based; GitHub-style; split/unified view; file tree; guided code tour; dark mode; Mermaid diagrams — https://github.com/nilbuild/diffity
- Comment support: inline comments on diffs, files, or folders; `/diffity-resolve` auto-applies all comments; `/diffity-review` for AI-initiated review — https://github.com/nilbuild/diffity
- Tech stack: TypeScript monorepo (cli, git, github, parser, ui packages); React 19.2.4, React Router 7, Tailwind CSS 4, TanStack Query 5, TanStack Virtual 3, better-sqlite3 12 (comment state), commander 14, Vite — https://raw.githubusercontent.com/nilbuild/diffity/main/packages/cli/package.json

---

## 4. PocketBase

### Embedding as a Go library
- Yes: call `pocketbase.New()` or `pocketbase.NewWithConfig(config)`, register hooks/routes, call `app.Start()` — runs inside your binary, no separate process — https://pocketbase.io/docs/go-overview/
- Framing: "a portable backend at the end" — https://pocketbase.io/docs/use-as-framework/

### Features added beyond plain SQLite
- Admin UI: dashboard at `/_/` for managing collections/records/settings — https://pocketbase.io/docs/
- REST API: CRUD at `/api/` with filtering, sorting, pagination — https://pocketbase.io/docs/
- Realtime: SSE-based subscriptions on record create/update/delete (not on View collections) — https://pocketbase.io/docs/
- Auth: built-in Auth collection type with email/password/tokenKey/verified; multiple independent Auth collections — https://pocketbase.io/docs/collections/
- Also bundles: static file serving, job scheduler, email templates, file storage — https://pocketbase.io/docs/

### Binary size
- Default build uses modernc.org/sqlite (pure Go, no CGO)
- Using `-tags no_default_driver` + custom driver reduces binary size by ~4 MB — https://pocketbase.io/docs/go-overview/

### Schema / migration model
- 14 field types: BoolField, NumberField, TextField, EmailField, URLField, EditorField, DateField, AutodateField, SelectField, FileField, RelationField, JSONField, GeoPoint — https://pocketbase.io/docs/collections/
- 3 collection types: Base, View (SQL SELECT-backed, read-only), Auth — https://pocketbase.io/docs/collections/
- Migrations: `.go` files with upgrade+downgrade functions; tracked in `_migrations` table; run auto on startup; `migrate up/down/history-sync` CLI available — https://pocketbase.io/docs/go-migrations/

### modernc.org/sqlite (pure Go, no CGO)
- CGO required: no — "a CGo-free port of the C SQLite3 library" — https://pkg.go.dev/modernc.org/sqlite
- Version: v1.53.0 (2026-06-21), SQLite 3.53.2, License: BSD-3-Clause — https://pkg.go.dev/modernc.org/sqlite
- Cross-compilation: standard GOOS/GOARCH, no C toolchain needed — https://pkg.go.dev/modernc.org/sqlite
- Supported targets: darwin (amd64/arm64), linux (386/amd64/arm/arm64/loong64/ppc64le/riscv64/s390x), windows (386/amd64/arm64), freebsd (amd64/arm64) — https://pkg.go.dev/modernc.org/sqlite
- Caveat: consuming go.mod must pin exact same version of `modernc.org/libc` as sqlite's go.mod declares — https://pkg.go.dev/modernc.org/sqlite

### mattn/go-sqlite3 (CGO required)
- CGO required: yes — requires `CGO_ENABLED=1` and `gcc` in PATH — https://github.com/mattn/go-sqlite3
- Cross-compilation: possible but requires setting `CC` to cross-compiler per target; xgo and musl-cross referenced — https://github.com/mattn/go-sqlite3
- Latest stable: v1.14.16 (released 2022-10-26) — https://github.com/mattn/go-sqlite3/releases

---

## 5. git-spice

### Machine-readable output
- Only two commands support `--json`: `gs log short` and `gs log long` — https://abhinav.github.io/git-spice/cli/json/
- Added in v0.18.0 — https://abhinav.github.io/git-spice/cli/json/
- Output: newline-delimited JSON objects (one per branch), unspecified order — https://abhinav.github.io/git-spice/cli/json/
- `gs log short/long --all` (or `-a`) enumerates all tracked branches, not just current stack slice — https://abhinav.github.io/git-spice/cli/json/
- JSON schema per object includes: name, current, down (downstream branch), ups (upstream branches), commits (long only), change (id, url, status, comments), push (ahead, behind, needsPush) — https://abhinav.github.io/git-spice/cli/json/

### Where metadata is stored
- All state stored under git ref: `refs/spice/data` — https://abhinav.github.io/git-spice/guide/internals/
- Constant defined in `repo_init.go`: `const _dataRef = "refs/spice/data"` — https://github.com/abhinav/git-spice/blob/main/repo_init.go
- Ref points to a commit object; tree contains flat key-value JSON blobs — https://github.com/abhinav/git-spice/blob/main/DESIGN.md
- Keys: `repo` (trunk, remote), `branches/<name>` (per-branch state), `templates/`, `rebase-continue`, `prepared/<name>` — https://github.com/abhinav/git-spice/blob/main/internal/spice/state/branch.go
- Per-branch JSON: `base` (name, hash), `upstream` (branch), `change` (forge-keyed map, e.g. `{"github": {"pr": 123}}`), `merged` (downstack history) — https://github.com/abhinav/git-spice/blob/main/internal/spice/state/branch.go
- Official inspection command: `git log --patch refs/spice/data` — https://abhinav.github.io/git-spice/guide/internals/
- Stability warning: "Internal details... may change at any time" — https://abhinav.github.io/git-spice/guide/internals/

### Branch-to-PR mapping
- One branch = one Change Request (PR/MR) — https://github.com/abhinav/git-spice/blob/main/branch_submit.go
- `gs branch submit` pushes branch, creates PR; base is set to the git-spice base (next branch down the stack) — https://github.com/abhinav/git-spice/blob/main/DESIGN.md
- PR number written back to `branches/<name>` in `refs/spice/data` after creation — https://github.com/abhinav/git-spice/blob/main/internal/handler/submit/handler.go
- Subsequent submits update the existing PR rather than creating a new one — https://github.com/abhinav/git-spice/blob/main/DESIGN.md
- Navigation comments cross-linking all PRs in stack posted to each PR; configurable via `spice.submit.navigationComment` in git config — https://github.com/abhinav/git-spice/blob/main/DESIGN.md

### Third-party extension points
- No documented plugin/extension API — https://abhinav.github.io/git-spice/community/integrations/
- Only official programmatic interface: `--json` on `gs log short`/`gs log long` — https://abhinav.github.io/git-spice/cli/json/
- Configuration via standard `git config` (namespace `spice.*`) — https://github.com/abhinav/git-spice/blob/main/DESIGN.md
- One community integration (Emacs Magit plugin) works by invoking CLI directly, confirming CLI is the only integration surface — https://github.com/jesse-c/git-spice.el

---

## 6. Go Binary Serving Embedded React SPA + Realtime

### go:embed + http.FileServer
- Pattern: `//go:embed` directive on `embed.FS` var; `embed.FS` implements `io/fs.FS`; wire via `http.FileServer(http.FS(content))` — https://pkg.go.dev/embed
- SPA caveat: `http.FileServer` returns 404 for unknown paths, breaking client-side routing; must wrap with middleware that falls back to `index.html` — https://hackandsla.sh/posts/2021-11-06-serve-spa-from-go/
- Files starting with `_` or `.` excluded by default; use `//go:embed all:dist` to include `_next/` etc. — https://blog.flipt.io/embedding-react-in-go

### SSE (Server-Sent Events)
- Go stdlib sufficient — no external library required; set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`; call `http.Flusher.Flush()` after each event — https://www.freecodecamp.org/news/how-to-implement-server-sent-events-in-go/
- Must type-assert `ResponseWriter` to `http.Flusher`; if assertion fails, SSE cannot work — https://www.freecodecamp.org/news/how-to-implement-server-sent-events-in-go/
- CORS caveat during dev: SPA dev server on different port requires `Access-Control-Allow-Origin: *`; disappears when SPA is embedded and served from same origin — https://www.freecodecamp.org/news/how-to-implement-server-sent-events-in-go/
- SSE is unidirectional (server → client only)

### WebSocket libraries
- `gorilla/websocket`: archived Dec 2022; concurrent writes panic (caller must serialize) — https://websocket.org/guides/languages/go/
- `coder/websocket` (formerly `nhooyr.io/websocket`): actively maintained by Coder since 2024; handles concurrent writes internally; full context.Context support; pure Go masking (1.75x faster than gorilla); Wasm support; zero external deps — https://github.com/coder/websocket
- Import path changed from `nhooyr.io/websocket` to `github.com/coder/websocket` when Coder adopted it; no breaking API changes — https://coder.com/blog/websocket
