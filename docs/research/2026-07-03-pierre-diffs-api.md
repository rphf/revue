# @pierre/diffs v1.2.x — API Dossier for Revue Planning

Sources checked: https://diffs.com/docs (Context7 /websites/diffs), github.com/wong2/diffx (uses ^1.2.9),
github.com/oorestisime/opencode-diffs (uses 1.1.0-beta.13 vanilla), pierre.computer/writing/on-rendering-diffs,
trees.software/docs, npmjs.com/package/@pierre/trees.

---

## 1. Input Format

**Primary path — patch string → parse → FileDiffMetadata → React component:**

```ts
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'

const [parsed] = await parsePatchFiles(gitPatchString)
// parsed.files: FileDiffMetadata[]

<FileDiff fileDiff={parsed.files[0]} ... />
```

`parsePatchFiles(patchContent, cacheKeyPrefix?, throwOnError?)` → `Array<{ files: FileDiffMetadata[] }>`
Handles single-file and multi-commit `.patch` files (e.g. GitHub PR `.patch` URLs).

**Alternative — old/new full contents → parse → FileDiffMetadata:**

```ts
import { parseDiffFromFile } from '@pierre/diffs'

const meta = parseDiffFromFile(oldContents, newContents, throwOnError?)
// -> FileDiffMetadata
```
Also: `processFile(patchChunk, { cacheKey, oldFile, newFile })` to upgrade a patch-only partial diff to a full diff
(used by diffx `useFullDiffs` to enable hunk context expansion).

**FileDiffMetadata key fields** (confirmed from diffx source):
- `name` — canonical file path
- `type` — `'new' | 'deleted' | 'change' | 'rename-changed'`
- `hunks[]` — with `additionStart/Count/LineIndex`, `deletionStart/Count/LineIndex`
- `additionLines[]`, `deletionLines[]` — full file content arrays (partial diffs have sparse arrays)
- `splitLineCount`, `unifiedLineCount`
- `isPartial` — true when parsed from patch only (no full file contents)
- `prevObjectId`, `newObjectId` — git OIDs
- `prevName` — old path (renames)

**Go server implication:** Serve the raw unified patch string. The frontend calls `parsePatchFiles()` to produce
`FileDiffMetadata[]`. For full hunk-context expansion (optional), also expose a `/api/file-versions` endpoint
returning `{ old: string, new: string }` and call `processFile()` to upgrade partial diffs.

**MultiFileDiff — React component for showing multiple files:**
Accepts a `files` prop (`FileDiffMetadata[]`). No raw patch prop — caller parses first.

**PatchDiff — convenience React component:**
Accepts a `patch` prop (raw unified diff string). Parses internally.

---

## 2. Annotation API

`DiffLineAnnotation<T>` shape (confirmed from diffx DiffViewer.tsx + opencode-diffs app.ts):

```ts
type DiffLineAnnotation<T> = {
  side: 'additions' | 'deletions'  // which gutter to anchor to
  lineNumber: number                 // 1-based absolute line number
  metadata: T                        // arbitrary user data, passed back to renderAnnotation
}
```

`LineAnnotation<T>` (for `File` component, non-diff single-file view):
```ts
type LineAnnotation<T> = {
  lineNumber: number  // no `side` field
  metadata: T
}
```

**Passed to FileDiff via `lineAnnotations` prop:**
```tsx
<FileDiff
  fileDiff={meta}
  lineAnnotations={annotations}           // DiffLineAnnotation<T>[]
  renderAnnotation={(annotation) => (     // annotation: DiffLineAnnotation<T>
    <CommentForm ... />
  )}
  renderGutterUtility={(getHoveredLine) => (
    <button onClick={() => {
      const line = getHoveredLine()       // -> { side: AnnotationSide, lineNumber: number } | null
      if (line) setPending(line)
    }}>+</button>
  )}
/>
```

Key: annotations are **not** keyed by file path inside the component — the per-file `FileDiff` instance owns its
own annotations array. The caller (Go server → React) manages the file→annotations mapping externally.

`renderAnnotation` returns React elements (React API) or DOM nodes (Vanilla JS API). The annotation appears
inline in the diff at the specified line/side. Annotations survive re-renders as long as `lineAnnotations` array
identity is stable; diffx wraps each file in `memo()` and forces remount on `isPartial` transitions.

**Imperative update (Vanilla JS):** `instance.setLineAnnotations(annotations)` — no re-render overhead.

---

## 3. Line Selection

**Vanilla JS API** (opencode-diffs app.ts, confirmed):

```ts
new FileDiff({
  enableLineSelection: true,
  onLineSelectionEnd: (value) => {
    // value: null (cleared) or { start, end, side, endSide }
    // side: 'additions' | 'deletions'
  },
  onLineClick: (value) => {
    // value: { lineNumber, annotationSide }
  },
})
```

For `File` (single-file, no diff):
```ts
new File({
  enableLineSelection: true,
  onLineSelectionEnd: (value) => { /* { start, end } — no side */ },
  onLineClick: (value) => { /* { lineNumber } */ },
})
```

**React API:** Same props available on `<FileDiff>` component (diffx uses `enableGutterUtility` + `renderGutterUtility`
instead of `enableLineSelection`). The gutter `+` button approach via `renderGutterUtility(getHoveredLine)` is the
confirmed React pattern for triggering comment creation at a specific line (diffx FileDiffCard.tsx).

**Programmatic selection read/set:**
- `instance.setSelectedLines({ start, end, side?, endSide? })` — highlights a line range
- Annotations survive selection changes

**Planning implication:** Comment-thread anchor = `{ filePath, side: 'additions'|'deletions', lineNumber: number }`.
Store these three fields; they map 1:1 to `DiffLineAnnotation`.

---

## 4. Rendering Modes & Theming

**Options prop on FileDiff React component** (confirmed from diffx FileDiffCard.tsx):
```ts
options={{
  diffStyle: 'split' | 'unified',   // controlled externally; no built-in toggle UI
  stickyHeader: true,
  expansionLineCount: 20,
  enableGutterUtility: true,
  theme: { dark: 'github-dark', light: 'github-light' },
  themeType: 'system' | 'dark' | 'light',
  overflow: 'wrap' | 'scroll',
  unsafeCSS: ':host { --diffs-tab-size: 2; }',  // inject CSS into shadow root
}}
```

Vanilla JS constructor options also include: `diffIndicators: 'bars'`, `expandUnchanged: false`,
`collapsedContextThreshold: 5`, `hunkSeparators: 'simple'`, `disableFileHeader: true`.

**Theme names** (confirmed both repos): `'github-dark'`, `'github-light'`, `'pierre-dark'`, `'pierre-light'`.
Shiki is **bundled** inside the package — no consumer install required. Highlighting runs in a **web worker pool**;
`getSharedHighlighter()` exposes the Shiki instance, `preloadHighlighter(themes, langs)` pre-warms it.
`useWorkerPool()` React hook allows dynamic `setRenderOptions({ theme })`.

**Shadow DOM confirmed** (pierre.computer article + `unsafeCSS: ':host { ... }'` usage in diffx):
Each component renders inside a shadow root. Global CSS does not reach diff internals. Theming surface:
- `theme` / `themeType` options for Shiki syntax colors
- `unsafeCSS` for injecting arbitrary CSS into `:host` (tab size, custom spacing)
- CSS custom properties may pierce the shadow boundary

---

## 5. Virtualization Constraints

`Virtualizer` from `@pierre/diffs/react` is the required scroll container:

```tsx
import { Virtualizer } from '@pierre/diffs/react'

<Virtualizer className="main-scroll" contentClassName="main-content">
  {files.map(f => <FileDiff key={f.name} fileDiff={f} ... />)}
</Virtualizer>
```

- `Virtualizer` **is** the scroll container — do not place it inside another overflow container.
- **Window scrolling is not supported** without manual orchestration (diffs.com/docs confirmed).
- The `FileDiff` component under `Virtualizer` does **not** re-process in-place prop changes to `fileDiff`
  when virtualized — diffx solves this by adding `isPartial` to the React key to force remount.
- `CodeView` (lower-level) adds `itemMetrics`, `stickyHeaders`, `smoothScrollSettings` for advanced control.

---

## 6. React/Build Compat

- diffx uses React **19** (`react@^19.1.0`, `@types/react@^19.1.2`) — confirmed in package.json.
- `@pierre/diffs` v1.2.9 used as devDependency in diffx with React 19; no peer dep conflicts observed.
- opencode-diffs uses 1.1.0-beta.13 (older) without React at all (vanilla JS).
- Build: diffx uses **Vite 8** + `@vitejs/plugin-react` — fully compatible.
- **Shadow DOM implication for Vite:** No special config needed; styles are injected via `unsafeCSS`
  option, not via Vite CSS pipeline. Do NOT expect global CSS classes or Tailwind to style diff internals.
- React import: `import { FileDiff, Virtualizer } from '@pierre/diffs/react'` (separate entrypoint).

---

## 7. Real-World Usage: wong2/diffx

Full integration confirmed from source (github.com/wong2/diffx `src/ui/`):

| Decision | diffx approach |
|---|---|
| Diff input | `parsePatchFiles(rawPatch)` on frontend; Go server streams raw `git diff` output |
| Per-file component | `<FileDiff fileDiff={meta} options={{...}} lineAnnotations={[...]} renderAnnotation={...} renderGutterUtility={...} />` |
| Comment anchor | `{ filePath, side: AnnotationSide, lineNumber: number }` stored in ReviewComment |
| Gutter trigger | `renderGutterUtility(getHoveredLine)` + `enableGutterUtility: true` option |
| Annotation render | `renderAnnotation(annotation)` → returns `<CommentForm>` (pending) or `<CommentBubble>` (saved) |
| Scroll container | `<Virtualizer>` wrapping all `<FileDiffCard>` instances |
| Theming | `theme: { dark: 'github-dark', light: 'github-light' }, themeType: 'system'` |
| Tab size | `unsafeCSS: ':host { --diffs-tab-size: N; }'` per file |
| File tree | Custom hand-rolled `<FileTree>` (NOT @pierre/trees) with `react-resizable` sidebar |

The server exposes `/api/file-versions?path=...&oldOid=...&newOid=...` to return `{ old, new }` full file
contents, used to upgrade partial diffs for hunk context expansion via `processFile()`.

---

## 8. @pierre/trees (Beta)

- Package: `@pierre/trees`, React entry: `@pierre/trees/react`
- Exports: `FileTree` component, `useFileTree(options)` hook, `useFileTreeSelector`, `useFileTreeSelection`
- Data shape: raw `string[]` of canonical paths (small trees) OR `prepareFileTreeInput(paths)` result (large trees)
- Selection: `useFileTreeSelector(model, selector)` reads `readonly string[]`; write via model methods
  (`resetPaths()`, etc.). Model updates after mount go through imperative methods, not prop re-renders.
- Shadow DOM: trees.software docs do not mention Shadow DOM (likely standard DOM)
- **Beta risk:** opencode-diffs pinned to `1.1.0-beta.13` (not ^1.x) suggesting breaking changes in flight.
  diffx **does not use @pierre/trees** — uses a custom `<FileTree>` component instead.
- **Replacement effort:** Low-to-medium. A custom file tree needs: path list → tree data structure, expand/collapse
  state, selection highlighting, scroll-to-active. diffx implemented this in ~100 lines (`FileTree.tsx`).
  Avoid @pierre/trees until it reaches stable 1.x.

---

## Summary for Go Server API Design

The Go server must provide:
1. **`GET /api/diff`** → raw unified patch string (output of `git diff ...`). Frontend calls `parsePatchFiles()`.
2. **`GET /api/file-versions`** → `{ old: string, new: string }` for optional full-diff upgrade.
3. Comments stored as `{ filePath, side: 'additions'|'deletions', lineNumber: number, ... }`.
   These map directly to `DiffLineAnnotation<T>` — no translation needed.
4. No need to pre-parse the diff server-side; no structured hunk format required from Go.
