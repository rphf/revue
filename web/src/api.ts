import type {
  ArchiveSelector,
  Branch,
  Comment,
  DiffResponse,
  FileVersions,
  History,
  Landed,
  Send,
  Settings,
  Side,
  Snapshot,
  Thread,
} from "./types";
import { argsQuery } from "./lib/diffArgs";

export class ApiError extends Error {}

// The text to show for anything a request or a parse threw.
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return undefined as T;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new ApiError(data?.message ?? resp.statusText);
  }
  return data as T;
}

export const api = {
  // Brings the browser app forward after a notification click (macOS).
  raise: () => request<void>("POST", "/api/raise"),
  // hideSpace leaves whitespace changes out, as GitHub's w=1 does.
  getDiff: (args: string[], hideSpace = false) =>
    request<DiffResponse>(
      "GET",
      `/api/diff${argsQuery(args, hideSpace ? { w: "1" } : undefined)}`,
    ),
  getDiffFile: (args: string[], path: string) =>
    request<FileVersions>("GET", `/api/diff/file${argsQuery(args, { path })}`),
  // Image URL for the rich markdown view, served from the checkout.
  assetUrl: (path: string) => `/api/asset?path=${encodeURIComponent(path)}`,
  // One side of an image file in this diff. The version changes the URL
  // whenever the diff moves, so an edited image loads again.
  diffImageUrl: (
    args: string[],
    path: string,
    side: "old" | "new",
    version: number,
  ) => `/api/diff/image${argsQuery(args, { path, side, v: String(version) })}`,
  // The checkout's threads, or another branch's.
  listThreads: (branch?: string) =>
    request<{ threads: Thread[] }>(
      "GET",
      `/api/threads?drafts=1${branch === undefined ? "" : `&branch=${encodeURIComponent(branch)}`}`,
    ),
  getBranches: () =>
    request<{ current: string; branches: Branch[] }>("GET", "/api/branches"),
  getSnapshot: (threadId: number) =>
    request<Snapshot>("GET", `/api/threads/${threadId}/snapshot`),
  createThread: (args: {
    args: string[];
    path: string;
    side: Side;
    line: number;
    startLine?: number;
    body: string;
  }) =>
    request<{ thread: Thread; comment: Comment }>("POST", "/api/threads", args),
  reply: (threadId: number, body: string) =>
    request<{ comment: Comment }>("POST", `/api/threads/${threadId}/comments`, {
      role: "reviewer",
      body,
    }),
  editComment: (commentId: number, body: string) =>
    request<{ comment: Comment }>("PATCH", `/api/comments/${commentId}`, {
      body,
    }),
  deleteComment: (commentId: number) =>
    request<void>("DELETE", `/api/comments/${commentId}`),
  resolveThread: (threadId: number, resolved: boolean) =>
    request<{ threadId: number; resolved: boolean }>(
      "POST",
      `/api/threads/${threadId}/${resolved ? "resolve" : "unresolve"}`,
      {},
    ),
  archiveThreads: (selector: ArchiveSelector) =>
    request<{ archived: number[]; skipped: number[]; head: string }>(
      "POST",
      "/api/threads/archive",
      selector,
    ),
  unarchiveThread: (threadId: number) =>
    request<{ threadId: number }>(
      "POST",
      `/api/threads/${threadId}/unarchive`,
      {},
    ),
  getLanded: () => request<Landed>("GET", "/api/landed"),
  getSettings: () => request<Settings>("GET", "/api/settings"),
  putSettings: (settings: Settings) =>
    request<Settings>("PUT", "/api/settings", settings),
  getHistory: (branch?: string, limit?: number) => {
    const q = new URLSearchParams();
    if (branch !== undefined) q.set("branch", branch);
    if (limit !== undefined) q.set("limit", String(limit));
    const qs = q.toString();
    return request<History>("GET", `/api/history${qs ? `?${qs}` : ""}`);
  },
  send: (note: string) =>
    request<{ send: Send; threads: Thread[] }>("POST", "/api/send", { note }),
};
