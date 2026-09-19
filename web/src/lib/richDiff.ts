import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked, type Token, type TokensList } from "marked";
import { api } from "../api";

// Rich diff of a markdown file, the way GitHub shows one: the new
// document rendered, with the blocks that changed marked. Blocks are
// marked's top-level tokens (a paragraph, a heading, a list, a code
// fence); the two token lists are aligned by longest common subsequence
// on their source text, so a moved or edited paragraph shows up as a
// removal next to an addition.

export type BlockChange = "same" | "added" | "removed";

export interface RichBlock {
  change: BlockChange;
  html: string;
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
  return doc.body.innerHTML;
}

function lex(markdown: string | null): TokensList {
  return marked.lexer(markdown ?? "");
}

function blockKey(token: Token): string {
  return token.raw.replace(/\s+$/, "");
}

// Renders one block on its own while keeping the document's link
// definitions, so reference-style links still resolve.
function renderBlock(
  token: Token,
  links: TokensList["links"],
  change: BlockChange,
  options: RenderOptions,
): RichBlock {
  const tokens = Object.assign([token], { links }) as TokensList;
  let html = DOMPurify.sanitize(
    marked.parser(tokens, { async: false }) as string,
  );
  if (options.resolveImage) html = rewriteImages(html, options.resolveImage);
  return { change, html };
}

export function diffBlocks(
  oldMarkdown: string | null,
  newMarkdown: string | null,
  options: RenderOptions = {},
): RichBlock[] {
  const oldTokens = lex(oldMarkdown);
  const newTokens = lex(newMarkdown);
  const a = oldTokens.filter((t) => t.type !== "space");
  const b = newTokens.filter((t) => t.type !== "space");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] is the common-subsequence length of a[i:] and b[j:].
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        blockKey(a[i]) === blockKey(b[j])
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: RichBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (blockKey(a[i]) === blockKey(b[j])) {
      out.push(renderBlock(b[j], newTokens.links, "same", options));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(renderBlock(a[i], oldTokens.links, "removed", options));
      i++;
    } else {
      out.push(renderBlock(b[j], newTokens.links, "added", options));
      j++;
    }
  }
  while (i < n)
    out.push(renderBlock(a[i++], oldTokens.links, "removed", options));
  while (j < m)
    out.push(renderBlock(b[j++], newTokens.links, "added", options));
  return out;
}

// Fetches both versions of every path the reviewer switched to rich
// view, from the round's frozen snapshot, and keeps the rendered blocks
// per review and round. Rounds never change, so nothing here goes stale.
export function useRichDocs(
  reviewId: number,
  roundSeq: number | null,
  paths: ReadonlySet<string>,
): ReadonlyMap<string, RichDoc> {
  const scope = `${reviewId}:${roundSeq}`;
  const [docs, setDocs] = useState<Map<string, RichDoc>>(new Map());
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (roundSeq === null) return;
    for (const path of paths) {
      const key = `${scope}:${path}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setDocs((prev) =>
        new Map(prev).set(key, { rev: `${key}:loading`, status: "loading" }),
      );
      const resolveImage = (src: string) => {
        const repoPath = resolveRepoPath(path, src);
        return repoPath === null
          ? src
          : api.assetUrl(reviewId, roundSeq, repoPath);
      };
      api
        .getFileVersions(reviewId, roundSeq, path)
        .then((v) => {
          setDocs((prev) =>
            new Map(prev).set(key, {
              rev: `${key}:ready`,
              status: "ready",
              blocks: diffBlocks(v.oldContent, v.newContent, { resolveImage }),
            }),
          );
        })
        .catch((e: unknown) => {
          requested.current.delete(key);
          setDocs((prev) =>
            new Map(prev).set(key, {
              rev: `${key}:error`,
              status: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        });
    }
  }, [reviewId, roundSeq, scope, paths]);

  // Stable across renders while nothing changed: the diff pane keys
  // its item versions on this map's contents, not its identity, but the
  // library still wants the same file object back for the same layout.
  return useMemo(() => {
    const byPath = new Map<string, RichDoc>();
    for (const path of paths) {
      const doc = docs.get(`${scope}:${path}`);
      if (doc) byPath.set(path, doc);
    }
    return byPath;
  }, [docs, scope, paths]);
}
