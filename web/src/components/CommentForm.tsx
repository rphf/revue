import { useState, type KeyboardEvent } from "react";

export interface CommentFormProps {
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

// GitHub-parity comment form: Escape and Cancel dismiss; non-empty
// content prompts confirm-discard first; submit-in-flight disables the
// button and server errors show inline (never losing the text).
export default function CommentForm({
  initial = "",
  placeholder = "Leave a comment",
  submitLabel = "Add comment",
  autoFocus = true,
  onSubmit,
  onCancel,
}: CommentFormProps) {
  const [body, setBody] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Unsaved text asks before it goes, inline rather than through the
  // browser's modal confirm, which blocks the page and paints oddly.
  const cancel = () => {
    if (body.trim() !== "" && body !== initial && !confirmingDiscard) {
      setConfirmingDiscard(true);
      return;
    }
    onCancel();
  };

  const submit = async () => {
    if (body.trim() === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
      return;
    }
    setPending(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      void submit();
    }
  };

  return (
    <div className="comment-form">
      <textarea
        value={body}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {confirmingDiscard ? (
          <span className="confirm-inline" role="status">
            Discard this comment?
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmingDiscard(false)}
            >
              Keep
            </button>
            <button type="button" className="btn btn-danger" onClick={onCancel}>
              Discard
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={cancel}
            disabled={pending}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={pending || body.trim() === ""}
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
