import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommentForm from "./CommentForm";

describe("CommentForm", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks inline before discarding non-empty content", () => {
    const onCancel = vi.fn();
    render(<CommentForm onSubmit={async () => {}} onCancel={onCancel} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "unsaved thought" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Discard this comment?",
    );
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("unsaved thought");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("cancels without asking when empty", () => {
    const onCancel = vi.fn();
    render(<CommentForm onSubmit={async () => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onCancel).toHaveBeenCalled();
  });

  it("Escape asks first, and a second Escape discards", () => {
    const onCancel = vi.fn();
    render(<CommentForm onSubmit={async () => {}} onCancel={onCancel} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "text" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Discard this comment?",
    );
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables submit in flight and re-enables with an inline error on failure", async () => {
    let reject!: (e: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    render(<CommentForm onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    const submit = screen.getByRole("button", { name: "Add comment" });
    fireEvent.click(submit);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    reject(new Error("server exploded"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("server exploded"),
    );
    expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled();
    // The text was not lost.
    expect(screen.getByRole("textbox")).toHaveValue("hello");
  });

  it("does not submit empty content", () => {
    const onSubmit = vi.fn();
    render(<CommentForm onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  });
});
