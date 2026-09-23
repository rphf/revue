import type { Comment, Thread } from "../types";

// Builders and stand-ins shared by the tests.

let nextCommentId = 1;

// A published reviewer comment on thread 1 unless told otherwise, with
// a fresh id each call.
export function comment(c: Partial<Comment> = {}): Comment {
  return {
    id: nextCommentId++,
    threadId: 1,
    authorRole: "reviewer",
    body: "",
    draft: false,
    createdAt: "2026-09-20T09:00:00Z",
    ...c,
  };
}

// Thread 1, open, on line 5 of a.go unless told otherwise.
export function thread(comments: Comment[], t: Partial<Thread> = {}): Thread {
  return {
    id: 1,
    path: "a.go",
    side: "additions",
    line: 5,
    resolved: false,
    createdAt: "2026-09-20T09:00:00Z",
    comments,
    ...t,
  };
}

// Deterministic EventSource stand-in: install it with
// vi.stubGlobal("EventSource", FakeEventSource) and drive it by hand.
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  static latest(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}
