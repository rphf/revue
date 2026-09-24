import { useEffect, useEffectEvent, useRef, useState } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { IS_MAC } from "@/lib/platform";

export interface SendComposerProps {
  draftCount: number;
  // The note as the reviewer left it, for a composer mounted again.
  initialNote?: string;
  // Gets the note when the composer unmounts, for a caller that keeps
  // it across remounts without a render per keystroke.
  onKeepNote?: (note: string) => void;
  // Resolves true once the send went out, which clears the note.
  onSend: (note: string) => Promise<boolean>;
  sending: boolean;
  error: string | null;
  // Bumped to move the caret into the note, when the reviewer asks to
  // write one.
  focusSignal: number;
}

// The foot of the threads panel: the note that goes out with this
// round's drafts, listed just above it. Send publishes every draft at
// once; a note with zero drafts is a valid send, nothing at all is not.
// The note is local state, so typing it re-renders the composer alone.
export default function SendComposer({
  draftCount,
  initialNote = "",
  onKeepNote,
  onSend,
  sending,
  error,
  focusSignal,
}: SendComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(initialNote);
  const keep = useEffectEvent(() => onKeepNote?.(note));
  useEffect(() => () => keep(), []);
  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus();
  }, [focusSignal]);

  const nothing = draftCount === 0 && note.trim() === "";
  const send = () => {
    if (sending || nothing) return;
    void onSend(note).then((sent) => {
      if (sent) setNote("");
    });
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
        onChange={(e) => setNote(e.target.value)}
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
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <KbdGroup>
            <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
          to send
        </span>
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
