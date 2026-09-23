import { describe, expect, it } from "vitest";
import type { Comment, Send, Thread } from "../types";
import { groupByRound } from "./rounds";

const sends: Send[] = [
  { id: 1, note: "first", createdAt: "2026-09-20T10:00:00.123456789Z" },
  { id: 2, note: "second", createdAt: "2026-09-20T11:00:00Z" },
  { id: 3, note: "third", createdAt: "2026-09-20T12:00:00.5Z" },
];

let nextId = 1;
function comment(c: Partial<Comment>): Comment {
  return {
    id: nextId++,
    threadId: 0,
    authorRole: "reviewer",
    body: "",
    draft: false,
    createdAt: "2026-09-20T09:00:00Z",
    ...c,
  };
}

function thread(id: number, comments: Comment[]): Thread {
  return {
    id,
    path: "a.go",
    side: "additions",
    line: 1,
    resolved: false,
    createdAt: "2026-09-20T09:00:00Z",
    comments,
  };
}

const keys = (threads: Thread[], s: Send[] = sends) =>
  groupByRound(threads, s).map((r) => [r.key, r.threads.map((t) => t.id)]);

describe("groupByRound", () => {
  it("puts a thread under the send that published it", () => {
    expect(
      keys([
        thread(1, [comment({ sendId: 1 })]),
        thread(2, [comment({ sendId: 2 })]),
      ]),
    ).toEqual([
      ["send-2", [2]],
      ["send-1", [1]],
    ]);
  });

  it("moves a thread to the round of its latest agent reply", () => {
    const t = thread(1, [
      comment({ sendId: 1 }),
      comment({
        authorRole: "agent",
        createdAt: "2026-09-20T12:30:00.987654321Z",
      }),
    ]);
    expect(keys([t])).toEqual([["send-3", [1]]]);
  });

  it("keeps an agent reply before the next send in the round it answers", () => {
    const t = thread(1, [
      comment({ sendId: 1 }),
      comment({ authorRole: "agent", createdAt: "2026-09-20T10:30:00Z" }),
    ]);
    expect(keys([t])).toEqual([["send-1", [1]]]);
  });

  it("lists drafts first, including a draft reply on a sent thread", () => {
    const rounds = groupByRound(
      [
        thread(1, [comment({ sendId: 3 })]),
        thread(2, [comment({ sendId: 1 }), comment({ draft: true })]),
        thread(3, [comment({ draft: true })]),
      ],
      sends,
    );
    expect(rounds.map((r) => [r.key, r.threads.map((t) => t.id)])).toEqual([
      ["unsent", [2, 3]],
      ["send-3", [1]],
    ]);
    expect(rounds[1]).toMatchObject({ kind: "send", number: 3 });
  });

  it("numbers rounds in send order whatever the input order", () => {
    const rounds = groupByRound(
      [thread(1, [comment({ sendId: 2 })])],
      [...sends].reverse(),
    );
    expect(rounds[0]).toMatchObject({ number: 2, send: { note: "second" } });
  });

  it("has only the unsent round before the first send", () => {
    expect(keys([thread(1, [comment({ draft: true })])], [])).toEqual([
      ["unsent", [1]],
    ]);
  });
});
