import { describe, expect, it } from "vitest";
import type { Send, Thread } from "../types";
import { comment, thread } from "../test/fixtures";
import { groupByRound } from "./rounds";

const sends: Send[] = [
  { id: 1, note: "first", createdAt: "2026-09-20T10:00:00.123456789Z" },
  { id: 2, note: "second", createdAt: "2026-09-20T11:00:00Z" },
  { id: 3, note: "third", createdAt: "2026-09-20T12:00:00.5Z" },
];

const keys = (threads: Thread[], s: Send[] = sends) =>
  groupByRound(threads, s).map((r) => [r.key, r.threads.map((t) => t.id)]);

describe("groupByRound", () => {
  it("puts a thread under the send that published it", () => {
    expect(
      keys([
        thread([comment({ sendId: 1 })], { id: 1 }),
        thread([comment({ sendId: 2 })], { id: 2 }),
      ]),
    ).toEqual([
      ["send-2", [2]],
      ["send-1", [1]],
    ]);
  });

  it("moves a thread to the round of its latest agent reply", () => {
    const t = thread(
      [
        comment({ sendId: 1 }),
        comment({
          authorRole: "agent",
          createdAt: "2026-09-20T12:30:00.987654321Z",
        }),
      ],
      { id: 1 },
    );
    expect(keys([t])).toEqual([["send-3", [1]]]);
  });

  it("keeps an agent reply before the next send in the round it answers", () => {
    const t = thread(
      [
        comment({ sendId: 1 }),
        comment({ authorRole: "agent", createdAt: "2026-09-20T10:30:00Z" }),
      ],
      { id: 1 },
    );
    expect(keys([t])).toEqual([["send-1", [1]]]);
  });

  it("lists drafts first, including a draft reply on a sent thread", () => {
    const rounds = groupByRound(
      [
        thread([comment({ sendId: 3 })], { id: 1 }),
        thread([comment({ sendId: 1 }), comment({ draft: true })], { id: 2 }),
        thread([comment({ draft: true })], { id: 3 }),
      ],
      sends,
    );
    expect(rounds.map((r) => [r.key, r.threads.map((t) => t.id)])).toEqual([
      ["unsent", [2, 3]],
      ["send-3", [1]],
    ]);
    // Thread 2 took part in send 1, so counting starts there.
    expect(rounds[1]).toMatchObject({ kind: "send", number: 3 });
  });

  it("numbers rounds in send order whatever the input order", () => {
    const rounds = groupByRound(
      [
        thread([comment({ sendId: 2 })], { id: 1 }),
        thread([comment({ sendId: 3 })], { id: 2 }),
      ],
      [...sends].reverse(),
    );
    expect(rounds[0]).toMatchObject({ number: 2, send: { id: 3 } });
    expect(rounds[1]).toMatchObject({ number: 1, send: { note: "second" } });
  });

  // Archiving a commit's threads takes their rounds off the list: the
  // next conversation starts from Round 1, not from the repository's
  // count of sends.
  it("counts from the first send the listed threads took part in", () => {
    const rounds = groupByRound(
      [thread([comment({ sendId: 3 })], { id: 1 })],
      sends,
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ number: 1, send: { id: 3 } });
  });

  it("has only the unsent round before the first send", () => {
    expect(keys([thread([comment({ draft: true })], { id: 1 })], [])).toEqual([
      ["unsent", [1]],
    ]);
  });

  it("keeps counting while one thread goes back and forth", () => {
    const rounds = groupByRound(
      [
        thread(
          [
            comment({ sendId: 1 }),
            comment({ authorRole: "agent", createdAt: "2026-09-20T10:30:00Z" }),
            comment({ sendId: 2 }),
          ],
          { id: 1 },
        ),
        thread([comment({ sendId: 3 })], { id: 2 }),
      ],
      sends,
    );
    expect(rounds.map((r) => r.kind === "send" && r.number)).toEqual([3, 2]);
  });
});
