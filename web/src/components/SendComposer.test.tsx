import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SendComposer, { type SendComposerProps } from "./SendComposer";

function setup(props: Partial<SendComposerProps> = {}) {
  const onSend = vi.fn();
  const onNoteChange = vi.fn();
  render(
    <SendComposer
      draftCount={0}
      note=""
      onNoteChange={onNoteChange}
      onSend={onSend}
      sending={false}
      error={null}
      focusSignal={0}
      {...props}
    />,
  );
  return { onSend, onNoteChange };
}

describe("SendComposer", () => {
  it("needs a note when there is no draft", () => {
    const { onSend } = setup();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Note to the agent"), {
      key: "Enter",
      metaKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends a note alone, from the button or Cmd+Enter", () => {
    const { onSend } = setup({ note: "LGTM, commit it" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(screen.getByLabelText("Note to the agent"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("sends drafts without a note and passes edits up", () => {
    const { onSend, onNoteChange } = setup({ draftCount: 3 });
    fireEvent.change(screen.getByLabelText("Note to the agent"), {
      target: { value: "fix these" },
    });
    expect(onNoteChange).toHaveBeenCalledWith("fix these");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("disables sending in flight and shows errors", () => {
    setup({ draftCount: 1, sending: true, error: "server went away" });
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("server went away");
  });

  it("takes focus when asked", () => {
    setup({ focusSignal: 1 });
    expect(screen.getByLabelText("Note to the agent")).toHaveFocus();
  });
});
