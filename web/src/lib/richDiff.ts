import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked, type Token, type Tokens, type TokensList } from "marked";
import type { FileDiffMetadata } from "@pierre/diffs";
import { api, errorMessage } from "../api";
import type { Side } from "../types";

// Rich diff of a markdown file, the way GitHub shows one: the new
// document rendered, with the blocks that changed marked. Blocks are
// marked's top-level tokens (a paragraph, a heading, a code fence) and
// each item of a list; the two lists of blocks are aligned by longest
// common subsequence on their source text, so a moved or edited
// paragraph shows up as a removal next to an addition. Each block keeps
// the source lines it came from, so a comment on a block is a comment
// on those lines.

export type BlockChange = "same" | "added" | "removed";

// First and last source line of a block, 1-based.
export type LineRange = [start: number, end: number];

export interface RichBlock {
  change: BlockChange;
  html: string;
  // Where the block sits in each version of the file that has it.
  oldLines?: LineRange;
  newLines?: LineRange;
  // One item of a list, drawn as a list of its own.
  item?: boolean;
}

// The lines a comment on a block is written on.
export interface BlockTarget {
  side: Side;
  line: number;
  startLine?: number;
}

// A removed block is commented on the old file, any other on the new.
export function blockTarget(block: RichBlock): BlockTarget | null {
  const side: Side = block.change === "removed" ? "deletions" : "additions";
  const range = side === "deletions" ? block.oldLines : block.newLines;
  if (!range) return null;
  const [start, end] = range;
  return { side, line: end, startLine: start !== end ? start : undefined };
}

// The block a line of one side belongs to: the one that holds it, or
// the next one when the line is between two blocks. -1 when the side
// has no block at or after the line.
export function blockForLine(
  blocks: RichBlock[],
  side: Side,
  line: number,
): number {
  return blocks.findIndex((block) => {
    const range = side === "deletions" ? block.oldLines : block.newLines;
    return range !== undefined && line <= range[1];
  });
}

export type RichDoc = { rev: string } & (
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; blocks: RichBlock[] }
);

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export interface RenderOptions {
  // Maps an image src as written in the markdown to the URL to load.
  resolveImage?: (src: string) => string;
}

// Turns a reference written in a markdown file into a repository path,
// relative to the file's directory like GitHub resolves it. External
// URLs, anchors and data URIs return null and are left alone.
export function resolveRepoPath(basePath: string, ref: string): string | null {
  if (
    ref === "" ||
    ref.startsWith("#") ||
    ref.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref)
  ) {
    return null;
  }
  let pathPart = ref.split(/[?#]/, 1)[0];
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  const out = pathPart.startsWith("/") ? [] : basePath.split("/").slice(0, -1);
  for (const segment of pathPart.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

function rewriteImages(html: string, resolve: (src: string) => string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of doc.body.querySelectorAll("img[src]")) {
    img.setAttribute("src", resolve(img.getAttribute("src") ?? ""));
  }
  // A srcset lists candidates, each a URL with an optional descriptor:
  // the sources of a picture, such as its dark variant. A URL runs to
  // the next space, less the commas around it, so one with a comma
  // inside stays whole.
  for (const el of doc.body.querySelectorAll("[srcset]")) {
    const candidates = [
      ...(el.getAttribute("srcset") ?? "").matchAll(
        /([^,\s](?:\S*[^,\s])?)(?:\s+([^,]*[^,\s]))?/g,
      ),
    ].map(([, url, descriptor]) =>
      descriptor ? `${resolve(url)} ${descriptor}` : resolve(url),
    );
    el.setAttribute("srcset", candidates.join(", "));
  }
  return doc.body.innerHTML;
}

function lex(markdown: string | null): TokensList {
  return marked.lexer(markdown ?? "");
}

function blockKey(token: Token): string {
  return token.raw.replace(/\s+$/, "");
}

function newlines(text: string): number {
  return text.split("\n").length - 1;
}

// One block of the rendered document: a top-level token, or one item
// of a list, so a bullet is diffed and commented on its own.
interface Unit {
  // What to render: the token, or a list holding the one item.
  token: Token;
  key: string;
  lines: LineRange;
  item: boolean;
}

function rangeAt(line: number, raw: string): LineRange {
  const lead = newlines(/^\n*/.exec(raw)?.[0] ?? "");
  return [line + lead, line + newlines(raw.replace(/\s+$/, ""))];
}

// The blocks of a token list with their source lines: the raw texts of
// the tokens add up to the document, so a running count of newlines
// places each one, and an item is placed by its text inside its list.
function units(tokens: TokensList): Unit[] {
  const out: Unit[] = [];
  let line = 1;
  for (const token of tokens) {
    if (token.type === "list") {
      const list = token as Tokens.List;
      let at = 0;
      list.items.forEach((item, index) => {
        const found = list.raw.indexOf(item.raw, at);
        const offset = found < 0 ? at : found;
        at = offset + item.raw.length;
        out.push({
          token: {
            ...list,
            items: [item],
            start: list.ordered ? (list.start || 1) + index : list.start,
          },
          key: blockKey(item),
          lines: rangeAt(line + newlines(list.raw.slice(0, offset)), item.raw),
          item: true,
        });
      });
    } else if (token.type !== "space") {
      out.push({
        token,
        key: blockKey(token),
        lines: rangeAt(line, token.raw),
        item: false,
      });
    }
    line += newlines(token.raw);
  }
  return out;
}

// Renders one block on its own while keeping the document's link
// definitions, so reference-style links still resolve.
function renderHtml(
  token: Token,
  links: TokensList["links"],
  options: RenderOptions,
): string {
  const tokens = Object.assign([token], { links }) as TokensList;
  const html = DOMPurify.sanitize(
    marked.parser(tokens, { async: false }) as string,
  );
  return options.resolveImage
    ? rewriteImages(html, options.resolveImage)
    : html;
}

export function diffBlocks(
  oldMarkdown: string | null,
  newMarkdown: string | null,
  options: RenderOptions = {},
): RichBlock[] {
  const oldTokens = lex(oldMarkdown);
  const newTokens = lex(newMarkdown);
  const a = units(oldTokens);
  const b = units(newTokens);
  const n = a.length;
  const m = b.length;
  const removed = (u: Unit): RichBlock => ({
    change: "removed",
    html: renderHtml(u.token, oldTokens.links, options),
    oldLines: u.lines,
    item: u.item,
  });
  const added = (u: Unit): RichBlock => ({
    change: "added",
    html: renderHtml(u.token, newTokens.links, options),
    newLines: u.lines,
    item: u.item,
  });

  // lcs[i][j] is the common-subsequence length of a[i:] and b[j:].
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i].key === b[j].key
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: RichBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].key === b[j].key) {
      out.push({
        change: "same",
        html: renderHtml(b[j].token, newTokens.links, options),
        oldLines: a[i].lines,
        newLines: b[j].lines,
        item: b[j].item,
      });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(removed(a[i++]));
    } else {
      out.push(added(b[j++]));
    }
  }
  while (i < n) out.push(removed(a[i++]));
  while (j < m) out.push(added(b[j++]));
  return out;
}

interface RichEntry {
  // The parsed diff the document was rendered for.
  file: FileDiffMetadata;
  doc: RichDoc;
}

// Fetches both versions of every path the reviewer switched to rich
// view and renders its blocks. A document belongs to one parsed diff of
// its file: the diff page hands back the same metadata object while a
// file's section of the patch is unchanged, so a refresh refetches only
// the files that moved, and the previous document stays on screen until
// the new one lands. Paths that left the rich set or the diff are
// dropped.
export function useRichDocs(
  args: string[],
  files: FileDiffMetadata[] | null,
  paths: ReadonlySet<string>,
): ReadonlyMap<string, RichDoc> {
  const [entries, setEntries] = useState<ReadonlyMap<string, RichEntry>>(
    new Map(),
  );
  // The parsed diff each path was last requested for; a response for
  // an older one is dropped.
  const requested = useRef(new Map<string, FileDiffMetadata>());
  const revs = useRef(0);

  const byPath = useMemo(
    () => new Map((files ?? []).map((f) => [f.name, f])),
    [files],
  );

  useEffect(() => {
    if (files === null) return;
    for (const path of requested.current.keys()) {
      if (!paths.has(path) || !byPath.has(path)) requested.current.delete(path);
    }
    for (const path of paths) {
      const file = byPath.get(path);
      if (!file || requested.current.get(path) === file) continue;
      requested.current.set(path, file);
      // Each document that lands also drops the ones no longer wanted.
      const put = (doc: RichDoc) => {
        if (requested.current.get(path) !== file) return;
        const wanted = new Set(requested.current.keys());
        setEntries((prev) => {
          const next = new Map(
            [...prev].filter(([p]) => wanted.has(p) && p !== path),
          );
          return next.set(path, { file, doc });
        });
      };
      const resolveImage = (src: string) => {
        const repoPath = resolveRepoPath(path, src);
        return repoPath === null ? src : api.assetUrl(repoPath);
      };
      api
        .getDiffFile(args, path)
        .then((v) => {
          revs.current += 1;
          put({
            rev: `${path}:${revs.current}`,
            status: "ready",
            blocks: diffBlocks(v.oldContent, v.newContent, { resolveImage }),
          });
        })
        .catch((e: unknown) => {
          revs.current += 1;
          put({
            rev: `${path}:${revs.current}`,
            status: "error",
            message: errorMessage(e),
          });
        });
    }
  }, [args, files, byPath, paths]);

  // Stable across renders while nothing changed: the diff pane keys
  // its item versions on this map's contents, not its identity, but the
  // library still wants the same file object back for the same layout.
  return useMemo(() => {
    const docs = new Map<string, RichDoc>();
    for (const path of paths) {
      if (!byPath.has(path)) continue;
      docs.set(
        path,
        entries.get(path)?.doc ?? { rev: `${path}:loading`, status: "loading" },
      );
    }
    return docs;
  }, [entries, byPath, paths]);
}
