import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentNoteBar, AgentNoteBody } from "./AgentNote";
import { useNoteCollapsed } from "./useNoteCollapsed";

const note = (
  over: Partial<{ body: string; updatedAt: string; outdated: boolean }> = {},
) => ({
  body: "## Checked\n\n- unit tests pass",
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  outdated: false,
  ...over,
});

afterEach(() => localStorage.clear());

describe("AgentNoteBar", () => {
  it("names the note with its age and toggles it", async () => {
    const onToggle = vi.fn();
    render(
      <AgentNoteBar note={note()} collapsed={false} onToggle={onToggle} />,
    );
    expect(screen.getByText("Agent note")).toBeVisible();
    expect(screen.getByText(/5m ago/)).toBeVisible();
    expect(screen.queryByText(/code changed since/i)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse the agent note" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("says when the code changed after the note", () => {
    render(
      <AgentNoteBar
        note={note({ outdated: true })}
        collapsed
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText(/code changed since this note/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand the agent note" }),
    ).toBeVisible();
  });
});

describe("AgentNoteBody", () => {
  it("renders the note as markdown", () => {
    render(<AgentNoteBody note={note()} />);
    expect(screen.getByRole("heading", { name: "Checked" })).toBeVisible();
    expect(screen.getByText("unit tests pass")).toBeVisible();
  });
});

describe("useNoteCollapsed", () => {
  it("remembers the collapsed note, and opens a newer one", () => {
    const first = note();
    const { result, rerender } = renderHook(({ n }) => useNoteCollapsed(n), {
      initialProps: { n: first },
    });
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);

    const again = renderHook(() => useNoteCollapsed(first));
    expect(again.result.current[0]).toBe(true);

    rerender({ n: note({ updatedAt: new Date().toISOString() }) });
    expect(result.current[0]).toBe(false);
  });
});
