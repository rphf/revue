import type { Thread } from "../types";

// Whose move a thread waits on. Yours: the agent wrote last, a thread
// it started included. Drafts: a comment of yours is not sent yet.
// Agent: you wrote last and sent it. Resolved: nobody's.
export type Turn = "yours" | "drafts" | "agent" | "resolved";

export const TURNS: Turn[] = ["yours", "drafts", "agent", "resolved"];

export const turnLabel: Record<Turn, string> = {
  yours: "Your turn",
  drafts: "Drafts",
  agent: "Waiting on agent",
  resolved: "Resolved",
};

// A draft wins over a resolution: a reply being written on a resolved
// thread is still the reviewer's to send.
export function turnOf(t: Thread): Turn {
  if (t.comments.some((c) => c.draft)) return "drafts";
  if (t.resolved) return "resolved";
  return t.comments.at(-1)?.authorRole === "agent" ? "yours" : "agent";
}

export interface TurnGroup {
  turn: Turn;
  threads: Thread[];
}

// groupByTurn lists each thread once, in TURNS order, leaving empty
// groups out; threads keep their order.
export function groupByTurn(threads: Thread[]): TurnGroup[] {
  const by = new Map<Turn, Thread[]>(TURNS.map((t) => [t, []]));
  for (const t of threads) by.get(turnOf(t))!.push(t);
  return TURNS.map((turn) => ({ turn, threads: by.get(turn)! })).filter(
    (g) => g.threads.length > 0,
  );
}

// How many sends a thread took part in: its back-and-forths.
export function sendCount(t: Thread): number {
  return new Set(t.comments.flatMap((c) => c.sendId ?? [])).size;
}
