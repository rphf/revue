import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HistoryIcon,
} from "lucide-react";
import { formatDateTime, timeAgo } from "@/lib/time";
import type { AgentNote as Note } from "../types";
import Markdown from "./Markdown";

// The agent's handoff for the branch: a bar fixed above the diff, and
// its body at the top of the diff's scroll. Read-only: the reviewer
// answers in the note of a send.

export function AgentNoteBar({
  note,
  collapsed,
  onToggle,
}: {
  note: Note;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-sidebar px-4 text-sm"
      data-testid="agent-note"
    >
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={!collapsed}
        aria-label={
          collapsed ? "Expand the agent note" : "Collapse the agent note"
        }
        onClick={onToggle}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        )}
        <BotIcon className="size-4 text-agent" />
        Agent note
      </button>
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
    </div>
  );
}

export function AgentNoteBody({ note }: { note: Note }) {
  return (
    <div
      className="mt-3 rounded-lg border bg-sidebar px-4 py-3 text-sm"
      data-testid="agent-note-body"
    >
      <Markdown source={note.body} />
    </div>
  );
}
