import type {
  Comment,
  DiffResponse,
  FileVersions,
  Send,
  Side,
  Snapshot,
  Thread,
} from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
    throw new ApiError(
      resp.status,
      data?.error ?? "unknown",
      data?.message ?? resp.statusText,
    );
  }
  return data as T;
}

// Diff arguments travel as a repeated `arg` query parameter, one per
// argument, so pathspecs with spaces survive the round trip.
export function argsQuery(args: string[], extra?: Record<string, string>) {
  const q = new URLSearchParams();
  for (const a of args) q.append("arg", a);
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

export const api = {
  getDiff: (args: string[]) =>
    request<DiffResponse>("GET", `/api/diff${argsQuery(args)}`),
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
  listThreads: () =>
    request<{ threads: Thread[] }>("GET", "/api/threads?drafts=1"),
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
  listSends: () => request<{ sends: Send[] }>("GET", "/api/sends"),
  send: (note: string) =>
    request<{ send: Send; threads: Thread[] }>("POST", "/api/send", { note }),
};
