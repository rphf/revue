// API types mirroring the Go server's JSON shapes.

export type Side = "additions" | "deletions";
export type AnchorState = "live" | "outdated";
export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type AuthorRole = "reviewer" | "agent";

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  isBinary: boolean;
  // Byte size of each side a binary file has.
  oldSize?: number;
  newSize?: number;
}

// Where a thread sits in one diff: at its current line when the hunk
// is still there, at its origin when it is not.
export interface ThreadPosition {
  threadId: number;
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  state: AnchorState;
}

export interface DiffResponse {
  args: string[];
  branch: string;
  repo: string;
  version: number;
  patch: string;
  files: DiffFile[];
  anchors: ThreadPosition[];
}

export interface Comment {
  id: number;
  threadId: number;
  authorRole: AuthorRole;
  body: string;
  draft: boolean;
  sendId?: number;
  createdAt: string;
}

export interface Thread {
  id: number;
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  resolved: boolean;
  createdAt: string;
  comments: Comment[];
}

export interface Send {
  id: number;
  note: string;
  createdAt: string;
}

// The file as it was when the thread started.
export interface Snapshot {
  path: string;
  oldPath?: string;
  status: FileStatus;
  oldContent: string | null;
  newContent: string | null;
  createdAt: string;
}

export interface FileVersions {
  path: string;
  oldPath?: string;
  status: FileStatus;
  isBinary: boolean;
  oldContent: string | null;
  newContent: string | null;
}

// Persisted events carry an id; the diff.changed notice does not.
export interface RevueEvent {
  id?: number;
  type: string;
  payload: unknown;
  createdAt?: string;
}
