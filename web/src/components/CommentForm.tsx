import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { IS_MAC } from "@/lib/platform";
import { errorMessage } from "../api";

export interface CommentFormProps {
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  // Reports every edit, for a caller that keeps the text across remounts.
  onChange?: (body: string) => void;
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
  onChange,
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
      setError(errorMessage(e));
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
    <div className="w-full font-sans">
      <Textarea
        value={body}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setBody(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
        rows={3}
        className="min-h-18 bg-background text-sm"
      />
      {error && (
        <p className="mt-1.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <span className="mr-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
          <KbdGroup>
            <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
          to submit
        </span>
        {confirmingDiscard ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            role="status"
          >
            Discard this comment?
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setConfirmingDiscard(false)}
            >
              Keep
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              onClick={onCancel}
            >
              Discard
            </Button>
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancel}
            disabled={pending}
          >
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => void submit()}
          disabled={pending || body.trim() === ""}
        >
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
