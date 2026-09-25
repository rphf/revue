import { FileDiffIcon, HistoryIcon } from "lucide-react";
import type { Thread as ThreadType } from "../types";
import { Button } from "@/components/ui/button";
import Thread from "./Thread";

export type SnapshotMode = "then" | "since";

export interface OutdatedThreadProps {
  thread: ThreadType;
  onChanged: () => void;
  onOpen: (mode: SnapshotMode) => void;
}

function wasOn(t: ThreadType): string {
  if (t.line === 0) return "the whole file";
  if (t.startLine !== undefined && t.startLine !== t.line)
    return `lines ${t.startLine}–${t.line}`;
  return `line ${t.line}`;
}

// A thread whose code changed, kept under its file's header instead of
// leaving the diff: the conversation as anywhere else, with the code it
// was written on and what changed since one click away.
export default function OutdatedThread({
  thread,
  onChanged,
  onOpen,
}: OutdatedThreadProps) {
  return (
    <div className="grid gap-1" data-testid={`outdated-${thread.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 font-sans text-xs text-muted-foreground">
        <HistoryIcon className="size-3.5 shrink-0 text-renamed" />
        <span>
          Outdated · was on {wasOn(thread)}
          {thread.side === "deletions" && " (old side)"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onOpen("since")}
          >
            <FileDiffIcon />
            Changes since
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onOpen("then")}
          >
            <HistoryIcon />
            As it was
          </Button>
        </span>
      </div>
      <Thread thread={thread} onChanged={onChanged} />
    </div>
  );
}
