import type {
  Comment,
  ReviewDetail,
  Review,
  Round,
  RoundDetail,
  FileVersions,
  Thread,
  Side,
  Submission,
  Verdict,
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

export const api = {
  listReviews: () => request<{ reviews: Review[] }>("GET", "/api/reviews"),
  getReview: (id: number) => request<ReviewDetail>("GET", `/api/reviews/${id}`),
  getRound: (id: number, seq: number) =>
    request<RoundDetail>("GET", `/api/reviews/${id}/rounds/${seq}`),
  getPatch: async (id: number, seq: number): Promise<string> => {
    const resp = await fetch(`/api/reviews/${id}/rounds/${seq}/patch`);
    if (!resp.ok)
      throw new ApiError(resp.status, "patch_fetch", resp.statusText);
    return resp.text();
  },
  getFileVersions: (id: number, seq: number, path: string) =>
    request<FileVersions>(
      "GET",
      `/api/reviews/${id}/rounds/${seq}/file?path=${encodeURIComponent(path)}`,
    ),
  // Image URL for the rich markdown view: the round's snapshot when the
  // file changed in it, the checked-out file otherwise.
  assetUrl: (id: number, seq: number, path: string) =>
    `/api/reviews/${id}/rounds/${seq}/asset?path=${encodeURIComponent(path)}`,
  listThreads: (id: number) =>
    request<{ threads: Thread[] }>(
      "GET",
      `/api/reviews/${id}/threads?drafts=1`,
    ),
  createThread: (
    id: number,
    args: {
      path: string;
      side: Side;
      line: number;
      startLine?: number;
      body: string;
    },
  ) =>
    request<{ thread: Thread; comment: Comment }>(
      "POST",
      `/api/reviews/${id}/threads`,
      args,
    ),
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
  submit: (id: number, verdict: Verdict, summary: string) =>
    request<{ submission: Submission }>("POST", `/api/reviews/${id}/submit`, {
      verdict,
      summary,
    }),
  close: (id: number) =>
    request<{ review: Review }>("POST", `/api/reviews/${id}/close`, {}),
  reopen: (id: number) =>
    request<{ review: Review }>("POST", `/api/reviews/${id}/reopen`, {}),
  createRound: (id: number) =>
    request<{ round: Round; deduped: boolean; notice?: string }>(
      "POST",
      `/api/reviews/${id}/rounds`,
      {},
    ),
};
