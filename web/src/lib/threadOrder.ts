import type { Comment, Thread, ThreadPosition } from "../types";

export type ThreadSort = "activity" | "agent" | "file" | "created";

export const SORTS: ThreadSort[] = ["activity", "agent", "file", "created"];

export const sortLabel: Record<ThreadSort, string> = {
  activity: "Latest activity",
  agent: "Latest agent reply",
  file: "File order",
  created: "Created",
};

export type ThreadFilter = "mine" | "agentStarted" | "newReplies";

export const FILTERS: ThreadFilter[] = ["mine", "agentStarted", "newReplies"];

export const filterLabel: Record<ThreadFilter, string> = {
  mine: "I took part",
  agentStarted: "Agent started",
  newReplies: "New agent replies",
};

// Milliseconds since the epoch, 0 for a missing or bad timestamp.
function time(s: string | undefined): number {
  const t = Date.parse(s ?? "");
  return Number.isNaN(t) ? 0 : t;
}

function lastAgentComment(t: Thread): Comment | undefined {
  return t.comments.filter((c) => c.authorRole === "agent").at(-1);
}

// newReply is the thread's last comment when the agent wrote it after
// the last send (or nothing was sent yet), and the reviewer has not
// answered it.
export function newReply(
  t: Thread,
  lastSendAt: string | null,
): Comment | undefined {
  const c = t.comments.at(-1);
  if (c?.authorRole !== "agent") return undefined;
  return lastSendAt === null || time(c.createdAt) > time(lastSendAt)
    ? c
    : undefined;
}

export function matches(
  t: Thread,
  filters: ReadonlySet<ThreadFilter>,
  lastSendAt: string | null,
): boolean {
  if (
    filters.has("mine") &&
    !t.comments.some((c) => c.authorRole === "reviewer")
  )
    return false;
  if (filters.has("agentStarted") && t.comments[0]?.authorRole !== "agent")
    return false;
  if (filters.has("newReplies") && !newReply(t, lastSendAt)) return false;
  return true;
}

export interface Sortable {
  thread: Thread;
  position: ThreadPosition | undefined;
}

// Where the thread shows in the diff: its live position, else its origin.
export function shownAt(r: Sortable): { path: string; line: number } {
  return r.position?.state === "live"
    ? { path: r.position.path, line: r.position.line }
    : { path: r.thread.path, line: r.thread.line };
}

// sortRows returns the rows in the given order; ties keep creation order.
export function sortRows<R extends Sortable>(rows: R[], sort: ThreadSort): R[] {
  const byId = (a: R, b: R) => a.thread.id - b.thread.id;
  const latest = (pick: (t: Thread) => Comment | undefined) => (a: R, b: R) =>
    time(pick(b.thread)?.createdAt) - time(pick(a.thread)?.createdAt) ||
    byId(a, b);
  const compare: Record<ThreadSort, (a: R, b: R) => number> = {
    activity: latest((t) => t.comments.at(-1)),
    agent: latest(lastAgentComment),
    file: (a, b) => {
      const x = shownAt(a);
      const y = shownAt(b);
      return x.path.localeCompare(y.path) || x.line - y.line || byId(a, b);
    },
    created: byId,
  };
  return [...rows].sort(compare[sort]);
}

const KEY = "revue-thread-order";

export interface ThreadOrder {
  sort: ThreadSort;
  filters: ThreadFilter[];
}

export const DEFAULT_ORDER: ThreadOrder = { sort: "activity", filters: [] };

export function loadOrder(): ThreadOrder {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { sort, filters } = raw as Partial<ThreadOrder>;
      return {
        sort: SORTS.includes(sort as ThreadSort)
          ? (sort as ThreadSort)
          : DEFAULT_ORDER.sort,
        filters: Array.isArray(filters)
          ? FILTERS.filter((f) => filters.includes(f))
          : [],
      };
    }
  } catch {
    // An order that cannot be read falls back to the default.
  }
  return DEFAULT_ORDER;
}

export function saveOrder(order: ThreadOrder) {
  try {
    localStorage.setItem(KEY, JSON.stringify(order));
  } catch {
    // Not remembering the order only loses it on reload.
  }
}
