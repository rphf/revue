import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export interface SendDialogProps {
  draftCount: number;
  onSend: (note: string) => Promise<void>;
  onClose: () => void;
}

// Send publishes every draft at once, with an optional note: the note
// is where "LGTM" or "fix these, then commit" goes. A note with zero
// drafts is a valid send; nothing at all is not. Send-in-flight
// disables the button; server errors show inline and re-enable it.
export default function SendDialog({
  draftCount,
  onSend,
  onClose,
}: SendDialogProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nothing = draftCount === 0 && note.trim() === "";

  const send = async () => {
    if (pending || nothing) return;
    setPending(true);
    setError(null);
    try {
      await onSend(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
      return;
    }
    setPending(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="send-dialog">
        <DialogHeader>
          <DialogTitle>Send comments</DialogTitle>
          <DialogDescription>
            {draftCount === 0
              ? "No draft comments; the note alone is sent."
              : `Sending ${draftCount} draft comment${draftCount === 1 ? "" : "s"}.`}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          rows={3}
          autoFocus
        />
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void send()}
            disabled={pending || nothing}
          >
            {pending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
