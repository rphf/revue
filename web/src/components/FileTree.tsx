import {
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeRowDecorationContext,
  GitStatusEntry,
} from "@pierre/trees";
import { FileTree as Tree, useFileTree } from "@pierre/trees/react";
import { CopyIcon, EyeIcon, EyeOffIcon, InboxIcon } from "lucide-react";
import type { DiffFile } from "../types";
import { isTyping } from "@/lib/keys";
import { treeEntryCompare } from "./treePath";

// The changed-file sidebar is a @pierre/trees model: virtualized rows,
// flattened empty directory chains, sticky folders, keyboard navigation,
// type-to-search, and a git-status lane fed from the diff's file
// statuses. Revue adds the per-file viewed toggle as a row decoration
// plus a context menu, and turns row activation into a diff jump.
//
// Paths reach the tree as data and the library renders them as text
// nodes inside its shadow root; they are untrusted repo content and
// must never be interpolated into HTML here either.

export interface FileTreeProps {
  files: DiffFile[];
  additions?: number;
  deletions?: number;
  viewed: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath?: string;
  ref?: Ref<FileTreeHandle>;
}

// The tree's cursor, for J and K: the selected row, a file or a folder.
export interface FileTreeHandle {
  // Moves the cursor to the row shown next to it, if any, and returns
  // the row it is on; null when the cursor is not on a shown row.
  step(delta: 1 | -1): { path: string; isFile: boolean } | null;
  // Folds or unfolds the folder under the cursor; false on a file.
  toggleFolder(): boolean;
  // Moves the focus into the search box.
  focusSearch(): void;
}

const VIEWED_ICON = "revue-viewed";
const UNVIEWED_ICON = "revue-unviewed";

// Custom sprite for the viewed lane; the built-in sets have no check
// mark. Zero size keeps it out of the host's flex layout, like the
// library's own sprite; currentColor lets the CSS below pick colors.
const SPRITE_SHEET = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="0" height="0">
<symbol id="${VIEWED_ICON}" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="${UNVIEWED_ICON}" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
</svg>`;

// Shadow-root styles the host CSS variables cannot express: the viewed
// lane is a click target, and the check reads as "done". The library
// lets the decoration absorb the row's free space and shrink to nothing
// under a long, deeply nested name; here the name takes the ellipsis
// and the viewed lane keeps its size. The library shows its ellipsis
// when a name's wrapped copy is taller than one line, and a fractional
// browser zoom rounds a single line to slightly more than that; a name
// that wraps is at least two lines tall, so the test here is 1.5 lines.
const UNSAFE_CSS = `
[data-truncate-marker] { opacity: 0; }
@container measure (height > 1.5lh) { [data-truncate-marker] { opacity: 1; } }
[data-item-section="content"] { flex: 1 1 auto; }
[data-item-section="decoration"] { flex: 0 0 auto; min-width: 22px; overflow: visible; }
[data-item-section="decoration"] > span { cursor: pointer; color: var(--trees-fg-muted); overflow: visible; }
[data-item-section="decoration"] > span:hover { color: var(--trees-fg); }
[data-item-section="decoration"] [data-icon-name="${VIEWED_ICON}"] { color: var(--trees-git-added-color); }
[data-item-section="git"] { opacity: 1; font-weight: var(--trees-font-weight-semibold); }
`;

// The keys that open the library's search: one letter or digit.
const SEARCH_SEED = /^[\p{L}\p{N}]$/u;

const DECORATION_SELECTOR = '[data-item-section="decoration"] > span';

const MENU_ITEM =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

function toGitStatus(files: DiffFile[]): GitStatusEntry[] {
  return files.map((f) => ({ path: f.path, status: f.status }));
}

// The row button wraps the whole line, so a click anywhere in the tree
// resolves to its row through the composed path of the shadow DOM.
function rowFromEvent(event: Event): HTMLElement | null {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.type === "item") {
      return node;
    }
  }
  return null;
}

function isViewedDotTarget(event: Event): boolean {
  const target = event.composedPath()[0];
  return (
    target instanceof Element && target.closest(DECORATION_SELECTOR) !== null
  );
}

// Every ancestor directory of a path, shallowest first.
function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function FileTree({
  files,
  additions = 0,
  deletions = 0,
  viewed,
  onToggleViewed,
  onSelect,
  selectedPath,
  ref,
}: FileTreeProps) {
  const viewedRef = useRef(viewed);
  const initialFiles = useRef(files);

  // useFileTree reads its options only on the first render, so they are
  // built once; the effects below push later changes into the model.
  const [options] = useState(() => ({
    paths: files.map((f) => f.path),
    gitStatus: toGitStatus(files),
    sort: treeEntryCompare,
    initialExpansion: "open" as const,
    flattenEmptyDirectories: true,
    stickyFolders: true,
    search: true,
    density: "compact" as const,
    icons: { set: "complete" as const, spriteSheet: SPRITE_SHEET },
    unsafeCSS: UNSAFE_CSS,
    renderRowDecoration: ({ item }: FileTreeRowDecorationContext) => {
      if (item.kind !== "file") return null;
      const isViewed = viewedRef.current.has(item.path);
      return {
        icon: {
          name: isViewed ? VIEWED_ICON : UNVIEWED_ICON,
          width: 14,
          height: 14,
        },
        title: isViewed ? "Mark as not viewed" : "Mark as viewed",
      };
    },
  }));
  const { model } = useFileTree(options);

  // The model is created once; later diffs replace its paths in place.
  useEffect(() => {
    if (initialFiles.current === files) return;
    model.resetPaths(files.map((f) => f.path));
    model.setGitStatus(toGitStatus(files));
  }, [model, files]);

  // Decorations read the viewed set through a ref, so a toggle needs an
  // explicit row re-render; resetting the composition is the model's
  // public way to ask for one.
  useEffect(() => {
    viewedRef.current = viewed;
    model.setComposition(model.getComposition());
  }, [model, viewed]);

  // Jumps that originate outside the tree (thread panel, anchors, the
  // focused file) mirror into the selection without bouncing back
  // through onSelect. Selecting adds to the selection, so the row
  // selected before is let go: one row shows the file on screen.
  useEffect(() => {
    if (!selectedPath) return;
    const item = model.getItem(selectedPath);
    if (!item) return;
    for (const path of model.getSelectedPaths())
      if (path !== selectedPath) model.getItem(path)?.deselect();
    if (item.isSelected()) return;
    for (const dir of ancestorDirs(selectedPath)) {
      const d = model.getItem(dir);
      if (d && "expand" in d) d.expand();
    }
    item.select();
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" });
  }, [model, selectedPath, files]);

  // The cursor moves over the rows shown, folders too, as in lazygit:
  // the rows inside a folded folder are skipped. A row taken over from
  // the outside selection stays in place when it is not shown.
  useImperativeHandle(
    ref,
    () => ({
      step(delta) {
        const count = model.getVisibleCount();
        const rows = count > 0 ? model.getVisibleRows(0, count - 1) : [];
        const cursor = model.getSelectedPaths()[0] ?? selectedPath;
        const at = rows.findIndex((r) => r.path === cursor);
        if (at < 0) return null;
        const next = rows[at + delta] ?? rows[at];
        for (const path of model.getSelectedPaths())
          if (path !== next.path) model.getItem(path)?.deselect();
        model.getItem(next.path)?.select();
        // With the focus in the tree, the focus moves with the cursor,
        // so Enter on the row and the cursor act on the same row. A
        // scroll request would keep the focus where it is.
        const host = model.getFileTreeContainer();
        if (host?.contains(document.activeElement)) model.focusPath(next.path);
        else model.scrollToPath(next.path, { focus: false, offset: "nearest" });
        return { path: next.path, isFile: next.kind === "file" };
      },
      toggleFolder() {
        const cursor = model.getSelectedPaths()[0];
        const item = cursor === undefined ? null : model.getItem(cursor);
        if (!item || !("toggle" in item)) return false;
        item.toggle();
        return true;
      },
      focusSearch() {
        model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLInputElement>(
            "[data-file-tree-search-input]",
          )
          ?.focus();
      },
    }),
    [model, selectedPath],
  );

  const viewedCount = useMemo(
    () => files.reduce((n, f) => n + (viewed.has(f.path) ? 1 : 0), 0),
    [files, viewed],
  );

  const header = useMemo(
    () => (
      <div className="tree-header flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-xs">
        <span className="font-medium whitespace-nowrap">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        {additions + deletions > 0 && (
          <span
            className="font-mono whitespace-nowrap tabular-nums"
            aria-label={`${additions} added, ${deletions} removed lines`}
          >
            <span className="text-added">+{additions}</span>{" "}
            <span className="text-removed">−{deletions}</span>
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="whitespace-nowrap text-muted-foreground">
            {viewedCount} viewed
          </span>
          <span
            className="h-1 w-14 min-w-4 shrink overflow-hidden rounded-full bg-border"
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full bg-added transition-[width]"
              style={{
                width: `${files.length ? (viewedCount / files.length) * 100 : 0}%`,
              }}
            />
          </span>
        </span>
      </div>
    ),
    [files.length, viewedCount, additions, deletions],
  );

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
        <InboxIcon className="size-5 opacity-60" />
        No changed files
      </div>
    );
  }

  // Capture phase runs before the row's own click handler, so a click on
  // the viewed dot toggles without selecting or jumping.
  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!isViewedDotTarget(e.nativeEvent)) return;
    const path = rowFromEvent(e.nativeEvent)?.dataset.itemPath;
    if (!path) return;
    e.stopPropagation();
    e.preventDefault();
    onToggleViewed(path);
  };

  // The library opens its search on a letter or digit typed in the tree
  // and moves the focus into the search box. Here the search starts only
  // from a click on the box: the key never reaches the library and goes
  // on to the page as if the tree did not have the focus, so the page's
  // shortcuts work. The library ignores a prevented default, so the key
  // is stopped and sent again from outside the tree.
  const onKeyDownCapture = (e: ReactKeyboardEvent<HTMLElement>) => {
    const key = e.nativeEvent;
    // Escape leaves the search box, as it leaves every box in revue; the
    // library only clears the search and keeps the focus in the box.
    // Leaving the box closes the search.
    const box = key.composedPath()[0];
    if (key.key === "Escape" && box instanceof HTMLInputElement) {
      e.stopPropagation();
      e.preventDefault();
      box.blur();
      return;
    }
    if (!SEARCH_SEED.test(key.key) || key.ctrlKey || key.metaKey) return;
    if (key.altKey || isTyping(key)) return;
    e.stopPropagation();
    const again = new KeyboardEvent("keydown", {
      key: key.key,
      code: key.code,
      shiftKey: key.shiftKey,
      repeat: key.repeat,
      bubbles: true,
      cancelable: true,
    });
    e.currentTarget.parentElement?.dispatchEvent(again);
    if (again.defaultPrevented) e.preventDefault();
  };

  // Mouse clicks and Enter/Space on a focused row both land here as a
  // button click, so re-activating the selected file jumps again.
  const onClick = (e: ReactMouseEvent<HTMLElement>) => {
    const row = rowFromEvent(e.nativeEvent);
    const path = row?.dataset.itemPath;
    if (row?.dataset.itemType === "file" && path) onSelect(path);
  };

  const renderContextMenu = (
    item: ContextMenuItem,
    context: ContextMenuOpenContext,
  ) => (
    <div
      className="flex min-w-44 flex-col rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
      role="menu"
      aria-label={item.name}
    >
      {item.kind === "file" && (
        <button
          type="button"
          role="menuitem"
          className={MENU_ITEM}
          onClick={() => {
            onToggleViewed(item.path);
            context.close();
          }}
        >
          {viewed.has(item.path) ? (
            <EyeOffIcon className="size-4 text-muted-foreground" />
          ) : (
            <EyeIcon className="size-4 text-muted-foreground" />
          )}
          {viewed.has(item.path) ? "Mark as not viewed" : "Mark as viewed"}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => {
          void navigator.clipboard?.writeText(item.path);
          context.close();
        }}
      >
        <CopyIcon className="size-4 text-muted-foreground" />
        Copy path
      </button>
    </div>
  );

  return (
    <Tree
      model={model}
      className="file-tree"
      aria-label="Changed files"
      header={header}
      renderContextMenu={renderContextMenu}
      onClickCapture={onClickCapture}
      onClick={onClick}
      onKeyDownCapture={onKeyDownCapture}
    />
  );
}

export default memo(FileTree);
