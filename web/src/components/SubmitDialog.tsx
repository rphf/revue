import { useState } from "react";
import type { Verdict } from "../types";

export interface SubmitDialogProps {
  draftCount: number;
  onSubmit: (verdict: Verdict, summary: string) => Promise<void>;
  onClose: () => void;
}

const verdicts: { value: Verdict; label: string; hint: string }[] = [
  { value: "comment", label: "Comment", hint: "Feedback without a verdict" },
  { value: "request_changes", label: "Request changes", hint: "The agent should implement the comments" },
  { value: "approve", label: "Approve", hint: "Done; the review becomes read-only for the agent" },
];

// Submit review with a verdict and optional summary (R5). A zero-
// comment, verdict-only submission is legal. Submit-in-flight disables
// the button; server errors show inline and re-enable it.
export default function SubmitDialog({ draftCount, onSubmit, onClose }: SubmitDialogProps) {
  const [verdict, setVerdict] = useState<Verdict>("comment");
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(verdict, summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
      return;
    }
    setPending(false);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Submit review"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Submit review</h2>
        <p className="muted">
          {draftCount === 0
            ? "No pending comments — a verdict-only submission."
            : `Publishing ${draftCount} draft comment${draftCount === 1 ? "" : "s"}.`}
        </p>
        <div className="verdict-options">
          {verdicts.map((v) => (
            <label key={v.value} className="verdict-option">
              <input
                type="radio"
                name="verdict"
                value={v.value}
                checked={verdict === v.value}
                onChange={() => setVerdict(v.value)}
              />
              <span>
                <strong>{v.label}</strong>
                <span className="muted"> — {v.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <textarea
          placeholder="Summary (optional)"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={pending}>
            {pending ? "Submitting…" : "Submit review"}
          </button>
        </div>
      </div>
    </div>
  );
}
