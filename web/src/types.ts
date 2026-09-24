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
  // Where the thread was written: the branch ("" on a detached HEAD),
  // HEAD, and the diff arguments. Empty for threads from before origins
  // were recorded.
  branch?: string;
  head?: string;
  args?: string[];
  // Set once the thread left the views; the commit its code landed in.
  archivedAt?: string;
  archivedHead?: string;
}

// Threads whose code landed at HEAD but that are not archived yet.
export interface Landed {
  head: string;
  threadIds: number[];
}

export interface Settings {
  autoArchiveLanded: boolean;
}

// One commit of a branch's history with the threads that landed in it.
export interface HistoryCommit {
  hash: string;
  subject: string;
  date: string;
  // False for a commit the branch no longer contains (rewritten by a
  // rebase); missing for one the repository lost.
  onBranch: boolean;
  missing?: boolean;
  threads: Thread[];
}

// A branch with threads, open or archived.
export interface Branch {
  name: string;
  open: number;
  archived: number;
}

export interface History {
  branch: string;
  current: string;
  branches: { name: string; threads: number }[];
  commits: HistoryCommit[];
  more: boolean;
}

export type ArchiveSelector =
  { ids: number[] } | { landed: true } | { resolved: true } | { all: true };

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
