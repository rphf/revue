import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { BotIcon, HistoryIcon, XIcon } from "lucide-react";
import { formatDateTime, timeAgo } from "@/lib/time";
import { isTyping } from "@/lib/keys";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentNote as Note } from "../types";
import Markdown from "./Markdown";

// The agent's handoff for the branch: a button in the top bar opens it
// as a layer over the diff, which stays as it was underneath.
// Read-only: the reviewer answers in the note of a send.

// The note last shown, by its time: a newer note is marked unread.
const SEEN_KEY = "revue-agent-note-seen";
const listeners = new Set<() => void>();

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(updatedAt: string) {
  try {
    localStorage.setItem(SEEN_KEY, updatedAt);
  } catch {
    // Storage may be off; the note then stays marked.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function AgentNoteButton({
  note,
  open,
  onToggle,
}: {
  note: Note | null;
  open: boolean;
  onToggle: () => void;
}) {
  const seen = useSyncExternalStore(subscribe, readSeen);
  if (!note) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon-sm"
          className="relative"
          aria-label="Agent note"
          aria-pressed={open}
          onClick={onToggle}
        >
          <BotIcon className={note.outdated ? "text-renamed" : "text-agent"} />
          {seen !== note.updatedAt && (
            <span
              className="absolute top-1 right-1 size-1.5 rounded-full bg-agent"
              data-testid="agent-note-unread"
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Agent note <Kbd>N</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function AgentNoteView({
  note,
  onClose,
}: {
  note: Note;
  onClose: () => void;
}) {
  useEffect(() => markSeen(note.updatedAt), [note.updatedAt]);
  // The top layer takes Escape first, so a layer under it stays open.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || isTyping(e)) return;
    e.preventDefault();
    onClose();
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  return (
    <section
      className="flex h-full min-w-0 flex-col bg-background"
      aria-label="Agent note"
      data-testid="agent-note-view"
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-1.5 text-sm">
        <BotIcon className="size-4 text-agent" />
        <span className="font-medium">Agent note</span>
        <span
          className="text-xs text-muted-foreground"
          title={formatDateTime(note.updatedAt)}
        >
          {timeAgo(note.updatedAt)}
        </span>
        {note.outdated && (
          <span className="inline-flex items-center gap-1 text-xs text-renamed">
            <HistoryIcon className="size-3.5" />
            Code changed since this note
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Close the agent note"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Close <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-5">
          <Markdown source={note.body} />
        </div>
      </div>
    </section>
  );
}
