// API types mirroring the Go server's JSON shapes.

export type ReviewState = "open" | "approved" | "closed";
export type Verdict = "comment" | "request_changes" | "approve";
export type Side = "additions" | "deletions";
export type AnchorState = "live" | "outdated";
export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type AuthorRole = "reviewer" | "agent";

export interface Review {
  id: number;
  repoRoot: string;
  branch: string;
  sourceArgs: string[];
  state: ReviewState;
  createdAt: string;
  updatedAt: string;
}

export interface Round {
  id: number;
  reviewId: number;
  seq: number;
  patch: string;
  createdAt: string;
}

export interface RoundSummary {
  seq: number;
  createdAt: string;
}

export interface RoundFile {
  id: number;
  roundId: number;
  path: string;
  oldPath?: string;
  status: FileStatus;
  oldBlob?: string;
  newBlob?: string;
  isBinary: boolean;
}

export interface ThreadAnchor {
  id: number;
  threadId: number;
  roundId: number;
  path: string;
  side: Side;
  startLine?: number;
  line: number;
  state: AnchorState;
  hunkHash?: string;
}

export interface Comment {
  id: number;
  threadId: number;
  authorRole: AuthorRole;
  body: string;
  draft: boolean;
  submissionId?: number;
  createdAt: string;
}

export interface Thread {
  id: number;
  reviewId: number;
  originRoundId: number;
  resolved: boolean;
  createdAt: string;
  originRoundSeq: number;
  anchors: ThreadAnchor[];
  comments: Comment[];
}

export interface Submission {
  id: number;
  reviewId: number;
  roundId: number;
  verdict: Verdict;
  summary?: string;
  createdAt: string;
}

export interface RevueEvent {
  id: number;
  reviewId: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface ReviewDetail {
  review: Review;
  rounds: RoundSummary[];
  submissions: Submission[];
}

export interface RoundDetail {
  round: Round;
  files: RoundFile[];
  anchors: ThreadAnchor[];
}

export interface FileVersions {
  path: string;
  oldPath?: string;
  status: FileStatus;
  isBinary: boolean;
  oldContent: string | null;
  newContent: string | null;
}
