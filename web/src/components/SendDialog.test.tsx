import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SendDialog from "./SendDialog";

describe("SendDialog", () => {
  it("needs a note when there is no draft, then sends it", async () => {
    const onSend = vi.fn(async () => {});
    render(<SendDialog draftCount={0} onSend={onSend} onClose={() => {}} />);

    expect(screen.getByText(/the note alone is sent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Note/), {
      target: { value: "LGTM, commit it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("LGTM, commit it"));
  });

  it("sends drafts with an empty note and reports their count", async () => {
    const onSend = vi.fn(async () => {});
    render(<SendDialog draftCount={3} onSend={onSend} onClose={() => {}} />);
    expect(screen.getByText(/Sending 3 draft comments/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(""));
  });

  it("disables the button in flight and shows inline errors, re-enabling", async () => {
    let reject!: (e: Error) => void;
    const onSend = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    render(<SendDialog draftCount={1} onSend={onSend} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();

    reject(new Error("server went away"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("server went away"),
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});
