import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import { comment, thread } from "../test/fixtures";
import { groupByTurn, sendCount, turnOf } from "./turns";

const ids = (threads: Thread[]) =>
  groupByTurn(threads).map((g) => [g.turn, g.threads.map((t) => t.id)]);

describe("turnOf", () => {
  it("is yours when the agent wrote last", () => {
    expect(
      turnOf(
        thread([comment({ sendId: 1 }), comment({ authorRole: "agent" })]),
      ),
    ).toBe("yours");
  });

  it("is yours on a thread the agent started", () => {
    expect(turnOf(thread([comment({ authorRole: "agent" })]))).toBe("yours");
  });

  it("is the agent's when your sent comment is the last", () => {
    expect(
      turnOf(
        thread([
          comment({ sendId: 1 }),
          comment({ authorRole: "agent" }),
          comment({ sendId: 2 }),
        ]),
      ),
    ).toBe("agent");
  });

  it("is a draft while a comment of yours is not sent, resolved or not", () => {
    const t = thread([
      comment({ authorRole: "agent" }),
      comment({ draft: true }),
    ]);
    expect(turnOf(t)).toBe("drafts");
    expect(turnOf({ ...t, resolved: true })).toBe("drafts");
  });

  it("is nobody's once resolved", () => {
    expect(
      turnOf(thread([comment({ authorRole: "agent" })], { resolved: true })),
    ).toBe("resolved");
  });
});

describe("groupByTurn", () => {
  it("orders groups by turn, keeps thread order, drops empty groups", () => {
    expect(
      ids([
        thread([comment({ sendId: 1 })], { id: 1 }),
        thread([comment({ authorRole: "agent" })], { id: 2 }),
        thread([comment({ sendId: 1 })], { id: 3, resolved: true }),
        thread([comment({ sendId: 1 }), comment({ authorRole: "agent" })], {
          id: 4,
        }),
      ]),
    ).toEqual([
      ["yours", [2, 4]],
      ["agent", [1]],
      ["resolved", [3]],
    ]);
  });
});

describe("sendCount", () => {
  it("counts the distinct sends a thread took part in", () => {
    expect(
      sendCount(
        thread([
          comment({ sendId: 1 }),
          comment({ authorRole: "agent" }),
          comment({ sendId: 3 }),
          comment({ sendId: 3 }),
          comment({ draft: true }),
        ]),
      ),
    ).toBe(2);
  });
});
