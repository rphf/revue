import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentNoteButton, AgentNoteView } from "./AgentNote";

const note = (
  over: Partial<{ body: string; updatedAt: string; outdated: boolean }> = {},
) => ({
  body: "## Checked\n\n- unit tests pass",
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  outdated: false,
  ...over,
});

const withTooltips = { wrapper: TooltipProvider };

afterEach(() => localStorage.clear());

describe("AgentNoteButton", () => {
  it("renders nothing without a note", () => {
    const { container } = render(
      <AgentNoteButton note={null} open={false} onToggle={() => {}} />,
      withTooltips,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("marks a note not opened yet, is pressed while open, and toggles", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <AgentNoteButton note={note()} open={false} onToggle={onToggle} />,
      withTooltips,
    );
    const button = screen.getByRole("button", { name: "Agent note" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("agent-note-unread")).toBeInTheDocument();
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(<AgentNoteButton note={note()} open onToggle={onToggle} />);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});

describe("AgentNoteView", () => {
  it("shows the note with its age and when it went outdated", () => {
    render(
      <AgentNoteView note={note({ outdated: true })} onClose={() => {}} />,
      withTooltips,
    );
    const view = screen.getByTestId("agent-note-view");
    expect(screen.getByRole("heading", { name: "Checked" })).toBeVisible();
    expect(view).toHaveTextContent("unit tests pass");
    expect(view).toHaveTextContent("5m ago");
    expect(view).toHaveTextContent("Code changed since this note");
  });

  it("closes from its corner or with Escape", async () => {
    const onClose = vi.fn();
    render(<AgentNoteView note={note()} onClose={onClose} />, withTooltips);
    await userEvent.click(
      screen.getByRole("button", { name: "Close the agent note" }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("counts as read once shown, until a newer note", () => {
    const first = note();
    render(<AgentNoteView note={first} onClose={() => {}} />, withTooltips);
    render(
      <AgentNoteButton note={first} open={false} onToggle={() => {}} />,
      withTooltips,
    );
    expect(screen.queryByTestId("agent-note-unread")).toBeNull();
    render(
      <AgentNoteButton
        note={note({ updatedAt: new Date().toISOString() })}
        open={false}
        onToggle={() => {}}
      />,
      withTooltips,
    );
    expect(screen.getByTestId("agent-note-unread")).toBeInTheDocument();
  });
});
