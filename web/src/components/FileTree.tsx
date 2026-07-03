import { useMemo, useState } from "react";
import type { FileStatus, RoundFile } from "../types";

// Custom file tree (KTD9): changed-file list -> nested tree with
// expand/collapse, click-to-scroll, viewed dots, and status badges.
// Paths render as React text nodes only — they are untrusted repo
// content and must never become HTML.

interface TreeDir {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}

interface TreeLeaf {
  kind: "file";
  name: string;
  file: RoundFile;
}

type TreeNode = TreeDir | TreeLeaf;

// treePathCompare orders leaf paths exactly as the rendered tree
// flattens them: at the first differing component, directories sort
// before files, then names compare locale-wise. The diff pane sorts
// its file cards with this so tree order and diff order always match.
export function treePathCompare(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] === bs[i]) continue;
    const aIsDir = i < as.length - 1;
    const bIsDir = i < bs.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return as[i].localeCompare(bs[i]);
  }
  return as.length - bs.length;
}

function buildTree(files: RoundFile[]): TreeNode[] {
  const root: TreeDir = { kind: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = dir.children.find(
        (n): n is TreeDir => n.kind === "dir" && n.path === dirPath,
      );
      if (!next) {
        next = { kind: "dir", name: parts[i], path: dirPath, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts[parts.length - 1], file });
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.kind === "dir") sortNodes(n.children);
  };
  sortNodes(root.children);
  return root.children;
}

const statusBadge: Record<FileStatus, { label: string; className: string }> = {
  added: { label: "A", className: "badge badge-added" },
  modified: { label: "M", className: "badge badge-modified" },
  deleted: { label: "D", className: "badge badge-deleted" },
  renamed: { label: "R", className: "badge badge-renamed" },
};

export interface FileTreeProps {
  files: RoundFile[];
  viewed: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath?: string;
}

export default function FileTree({ files, viewed, onToggleViewed, onSelect, selectedPath }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  if (files.length === 0) {
    return <div className="tree-empty">No changed files</div>;
  }

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      if (node.kind === "dir") {
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={`dir:${node.path}`}>
            <button
              type="button"
              className="tree-row tree-dir"
              style={{ paddingLeft: depth * 14 + 6 }}
              onClick={() => toggleDir(node.path)}
              aria-expanded={!isCollapsed}
            >
              <span className="tree-caret">{isCollapsed ? "▸" : "▾"}</span>
              <span className="tree-name">{node.name}</span>
            </button>
            {!isCollapsed && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      const { file } = node;
      const badge = statusBadge[file.status];
      return (
        // The whole row is the click target (the viewed dot opts out),
        // so the pointer affordance matches the hit area.
        <div
          key={`file:${file.path}`}
          className={`tree-row tree-file${selectedPath === file.path ? " selected" : ""}`}
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => onSelect(file.path)}
        >
          <button
            type="button"
            className={`viewed-dot${viewed.has(file.path) ? " viewed" : ""}`}
            title={viewed.has(file.path) ? "Mark as not viewed" : "Mark as viewed"}
            aria-label={`Toggle viewed: ${file.path}`}
            aria-pressed={viewed.has(file.path)}
            onClick={(e) => {
              e.stopPropagation();
              onToggleViewed(file.path);
            }}
          />
          <button type="button" className="tree-name tree-link">
            {file.status === "renamed" && file.oldPath ? (
              <span className="tree-rename">
                <span className="tree-old-path">{file.oldPath}</span>
                {" → "}
                {node.name}
              </span>
            ) : (
              node.name
            )}
          </button>
          <span className={badge.className} title={file.status}>
            {badge.label}
          </span>
        </div>
      );
    });

  return <nav className="file-tree">{renderNodes(tree, 0)}</nav>;
}
