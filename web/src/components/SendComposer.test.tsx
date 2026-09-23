import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SendComposer, { type SendComposerProps } from "./SendComposer";

function setup(props: Partial<SendComposerProps> = {}) {
  const onSend = vi.fn(async () => true);
  const onKeepNote = vi.fn();
  const view = render(
    <SendComposer
      draftCount={0}
      onKeepNote={onKeepNote}
      onSend={onSend}
      sending={false}
      error={null}
      focusSignal={0}
      {...props}
    />,
  );
  return { onSend, onKeepNote, ...view };
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
    const onSend = vi.fn(async () => false);
    setup({ initialNote: "LGTM, commit it", onSend });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(screen.getByLabelText("Note to the agent"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenCalledWith("LGTM, commit it");
  });

  it("sends drafts with the typed note and clears it once sent", async () => {
    const { onSend } = setup({ draftCount: 3 });
    const box = screen.getByLabelText("Note to the agent");
    fireEvent.change(box, { target: { value: "fix these" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("fix these");
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the note when the send fails", async () => {
    const onSend = vi.fn(async () => false);
    setup({ draftCount: 1, onSend });
    const box = screen.getByLabelText("Note to the agent");
    fireEvent.change(box, { target: { value: "fix these" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(box).toHaveValue("fix these");
  });

  it("hands the note back when it closes", () => {
    const { onKeepNote, unmount } = setup({ initialNote: "half" });
    fireEvent.change(screen.getByLabelText("Note to the agent"), {
      target: { value: "half written" },
    });
    expect(onKeepNote).not.toHaveBeenCalled();
    unmount();
    expect(onKeepNote).toHaveBeenCalledWith("half written");
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
