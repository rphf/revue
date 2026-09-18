import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SubmitDialog from "./SubmitDialog";

describe("SubmitDialog", () => {
  it("allows a zero-comment, verdict-only submission", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <SubmitDialog draftCount={0} onSubmit={onSubmit} onClose={() => {}} />,
    );

    expect(screen.getByText(/verdict-only submission/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Approve/));
    fireEvent.change(screen.getByPlaceholderText(/Summary/), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("approve", "ship it"),
    );
  });

  it("defaults to the comment verdict and reports draft count", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <SubmitDialog draftCount={3} onSubmit={onSubmit} onClose={() => {}} />,
    );
    expect(screen.getByText(/Publishing 3 draft comments/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("comment", ""));
  });

  it("disables the button in flight and shows inline errors, re-enabling", async () => {
    let reject!: (e: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    render(
      <SubmitDialog draftCount={1} onSubmit={onSubmit} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();

    reject(new Error("review is closed"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("review is closed"),
    );
    expect(screen.getByRole("button", { name: "Submit review" })).toBeEnabled();
  });
});
