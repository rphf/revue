import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEvents } from "./useEvents";
import type { RevueEvent } from "./types";
import ConnectionBanner from "./components/ConnectionBanner";

// Deterministic EventSource stand-in.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function Harness({ onEvent }: { onEvent: (e: RevueEvent) => void }) {
  const state = useEvents(7, onEvent);
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
    expect(es.url).toBe("/api/reviews/7/events");

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

  it("delivers parsed events to the handler", () => {
    const events: RevueEvent[] = [];
    render(<Harness onEvent={(e) => events.push(e)} />);
    const es = FakeEventSource.instances[0];
    act(() =>
      es.onmessage?.({
        data: JSON.stringify({ id: 3, reviewId: 7, type: "round.created", payload: {}, createdAt: "" }),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("round.created");
  });

  it("closes the stream on unmount", () => {
    const { unmount } = render(<Harness onEvent={() => {}} />);
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
