import type { Comment, Send, Thread } from "../types";

// A round is what happened around one Send: the reviewer comments it
// published and the agent replies that came before the next one. The
// comments not sent yet make a round of their own, ahead of the rest.
export type Round =
  | { kind: "unsent"; key: string; threads: Thread[] }
  | {
      kind: "send";
      key: string;
      send: Send;
      // 1-based, counting sends from the first one the listed threads
      // took part in: once older threads are archived, the
      // conversation counts from 1 again.
      number: number;
      threads: Thread[];
    };

const UNSENT = Number.POSITIVE_INFINITY;

// The server writes RFC 3339 with up to nine fractional digits; Date
// only promises to parse three.
function millis(iso: string): number {
  return Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
}

// The index of the round a comment belongs to, in send order.
function commentRound(
  c: Comment,
  sends: Send[],
  indexById: Map<number, number>,
): number {
  if (c.draft) return UNSENT;
  const sent = c.sendId !== undefined ? indexById.get(c.sendId) : undefined;
  if (sent !== undefined) return sent;
  // An agent reply answers the last send before it.
  const at = millis(c.createdAt);
  let round = 0;
  for (let i = 0; i < sends.length; i++) {
    if (millis(sends[i].createdAt) <= at) round = i;
  }
  return sends.length === 0 ? UNSENT : round;
}

// groupByRound lists each thread once, under the latest round it has a
// comment in, the way `revue feedback --since` surfaces what moved. The
// unsent round comes first, then sends newest first; empty rounds are
// left out and threads keep their order. A round left empty because
// its threads moved on still counts: a thread going back and forth
// reads Round 1, 2, 3, not Round 1 each time.
export function groupByRound(threads: Thread[], sends: Send[]): Round[] {
  const ordered = [...sends].sort((a, b) => a.id - b.id);
  const indexById = new Map(ordered.map((s, i) => [s.id, i]));
  const unsent: Thread[] = [];
  const bySend: Thread[][] = ordered.map(() => []);
  let first = UNSENT;
  for (const t of threads) {
    const rounds = t.comments.map((c) => commentRound(c, ordered, indexById));
    first = Math.min(first, ...rounds);
    const round = Math.max(0, ...rounds);
    if (round === UNSENT || ordered.length === 0) unsent.push(t);
    else bySend[round].push(t);
  }
  const rounds: Round[] = [];
  if (unsent.length > 0)
    rounds.push({ kind: "unsent", key: "unsent", threads: unsent });
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (bySend[i].length === 0) continue;
    rounds.push({
      kind: "send",
      key: `send-${ordered[i].id}`,
      send: ordered[i],
      number: i - first + 1,
      threads: bySend[i],
    });
  }
  return rounds;
}
