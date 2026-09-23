import { useEffect, useRef } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";

export interface SendComposerProps {
  draftCount: number;
  note: string;
  onNoteChange: (note: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  // Bumped to move the caret into the note, when the reviewer asks to
  // write one.
  focusSignal: number;
}

const MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

// The foot of the threads panel: the note that goes out with this
// round's drafts, listed just above it. Send publishes every draft at
// once; a note with zero drafts is a valid send, nothing at all is not.
export default function SendComposer({
  draftCount,
  note,
  onNoteChange,
  onSend,
  sending,
  error,
  focusSignal,
}: SendComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus();
  }, [focusSignal]);

  const nothing = draftCount === 0 && note.trim() === "";
  const send = () => {
    if (!sending && !nothing) onSend();
  };

  return (
    <div
      className="grid shrink-0 gap-2 border-t bg-background p-3"
      data-testid="send-composer"
    >
      <Textarea
        ref={ref}
        aria-label="Note to the agent"
        placeholder="Note to the agent, optional: “LGTM, commit and push”"
        className="max-h-[40vh] min-h-24 resize-none"
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <KbdGroup className="text-xs text-muted-foreground">
          <Kbd>{MAC ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>Enter</Kbd>
        </KbdGroup>
        <Button
          type="button"
          size="sm"
          onClick={send}
          disabled={sending || nothing}
        >
          <SendIcon />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
