import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEvents } from "./useEvents";
import type { RevueEvent } from "./types";
import ConnectionBanner from "./components/ConnectionBanner";
import { FakeEventSource } from "./test/fixtures";

function Harness({
  args = [],
  onEvent,
}: {
  args?: string[];
  onEvent: (e: RevueEvent) => void;
}) {
  const state = useEvents(args, onEvent);
  return (
    <>
      <span data-testid="conn-state">{state}</span>
      <ConnectionBanner state={state} />
      <input data-testid="draft-input" defaultValue="" />
    </>
  );
}

describe("useEvents + ConnectionBanner", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the reconnect banner on drop and clears it on reconnect", () => {
    render(<Harness onEvent={() => {}} />);
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe("/api/events");

    act(() => es.onopen?.());
    expect(screen.getByTestId("conn-state")).toHaveTextContent("open");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Type into a form, then drop the connection.
    const input = screen.getByTestId<HTMLInputElement>("draft-input");
    input.value = "unsent draft text";
    act(() => es.onerror?.());
    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);
    // The banner is non-blocking: unsent form text survives.
    expect(input.value).toBe("unsent draft text");

    act(() => es.onopen?.());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(input.value).toBe("unsent draft text");
  });

  it("subscribes to the stream of the diff it is given", () => {
    render(<Harness args={["main...HEAD", "--", "web"]} onEvent={() => {}} />);
    expect(FakeEventSource.instances[0].url).toBe(
      "/api/events?arg=main...HEAD&arg=--&arg=web",
    );
  });

  it("delivers parsed events to the handler, with and without an id", () => {
    const events: RevueEvent[] = [];
    render(<Harness onEvent={(e) => events.push(e)} />);
    const es = FakeEventSource.instances[0];
    act(() =>
      es.onmessage?.({
        data: JSON.stringify({
          id: 3,
          type: "thread.replied",
          payload: {},
          createdAt: "",
        }),
      }),
    );
    act(() =>
      es.onmessage?.({
        data: JSON.stringify({
          type: "diff.changed",
          payload: { version: 4 },
        }),
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "thread.replied",
      "diff.changed",
    ]);
    expect(events[1].id).toBeUndefined();
  });

  it("resumes from the last event seen when the diff changes", () => {
    const { rerender } = render(<Harness onEvent={() => {}} />);
    const first = FakeEventSource.instances[0];
    act(() => {
      first.emit({ id: 7, type: "thread.created", payload: {} });
      first.emit({ type: "diff.changed", payload: { version: 2 } });
    });

    rerender(<Harness args={["--staged"]} onEvent={() => {}} />);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.latest().url).toBe(
      "/api/events?arg=--staged&since=7",
    );
  });

  it("keeps the stream while the arguments stay the same", () => {
    const { rerender } = render(<Harness args={["main"]} onEvent={() => {}} />);
    rerender(<Harness args={["main"]} onEvent={() => {}} />);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes the stream on unmount", () => {
    const { unmount } = render(<Harness onEvent={() => {}} />);
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
