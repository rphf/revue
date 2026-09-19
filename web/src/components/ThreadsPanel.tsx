import { useMemo, useState } from "react";
import { MessageSquareIcon, MessageSquareTextIcon, XIcon } from "lucide-react";
import type { Thread, ThreadAnchor } from "../types";
import { excerpt } from "@/lib/text";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type PanelFilter = "all" | "live" | "outdated" | "resolved";

const FILTERS: PanelFilter[] = ["all", "live", "outdated", "resolved"];

const stateDot: Record<Exclude<PanelFilter, "all">, string> = {
  live: "bg-added",
  outdated: "bg-renamed",
  resolved: "bg-muted-foreground/50",
};

export interface ThreadsPanelProps {
  threads: Thread[];
  currentRoundId: number;
  onJump: (thread: Thread, anchor: ThreadAnchor | undefined) => void;
  onClose: () => void;
}

// Review-level threads panel (R22): every thread with
// live/outdated/resolved filters. A thread whose file or hunk is gone
// from the current round stays reachable here and links back to its
// originating round. Rows lead with the opening comment, which is what
// a reviewer remembers a thread by; the file position is secondary.
export default function ThreadsPanel({
  threads,
  currentRoundId,
  onJump,
  onClose,
}: ThreadsPanelProps) {
  const [filter, setFilter] = useState<PanelFilter>("all");

  const classified = useMemo(
    () =>
      threads.map((t) => {
        const anchor = t.anchors.find((a) => a.roundId === currentRoundId);
        const state: Exclude<PanelFilter, "all"> = t.resolved
          ? "resolved"
          : anchor?.state === "live"
            ? "live"
            : "outdated";
        return { thread: t, anchor, state };
      }),
    [threads, currentRoundId],
  );

  const visible = classified.filter(
    (c) => filter === "all" || c.state === filter,
  );
  const count = (s: PanelFilter) =>
    classified.filter((c) => c.state === s).length;

  return (
    <div className="flex h-full flex-col" data-testid="threads-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquareTextIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">Threads</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {threads.length}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Close threads"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as PanelFilter)}
        className="gap-0"
      >
        <TabsList
          variant="line"
          className="h-9 w-full justify-start gap-0 border-b px-2"
        >
          {FILTERS.map((f) => (
            <TabsTrigger
              key={f}
              value={f}
              className="flex-none gap-1 px-2 text-xs capitalize"
            >
              {f}
              {f !== "all" && (
                <span className="text-muted-foreground tabular-nums">
                  {count(f)}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {visible.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No {filter === "all" ? "" : filter + " "}threads
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="divide-y">
            {visible.map(({ thread, anchor, state }) => {
              const origin = thread.anchors.find(
                (a) => a.roundId === thread.originRoundId,
              );
              const shown = anchor ?? origin;
              const first = thread.comments[0];
              const last = thread.comments[thread.comments.length - 1];
              const replies = Math.max(0, thread.comments.length - 1);
              const drafts = thread.comments.filter((c) => c.draft).length;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col gap-1.5 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                      state === "resolved" && "opacity-70",
                    )}
                    data-testid={`panel-thread-${thread.id}`}
                    onClick={() => onJump(thread, anchor)}
                  >
                    <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className={cn("size-1.5 rounded-full", stateDot[state])}
                      />
                      <span className="capitalize">{state}</span>
                      {state === "outdated" && (
                        <span>· round {thread.originRoundSeq}</span>
                      )}
                      {drafts > 0 && (
                        <span className="text-renamed">
                          · {drafts === 1 ? "draft" : `${drafts} drafts`}
                        </span>
                      )}
                      {last && (
                        <span className="ml-auto shrink-0">
                          {timeAgo(last.createdAt)}
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 text-sm leading-snug text-foreground">
                      {first ? excerpt(first.body) : ""}
                    </span>
                    <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-mono">
                        {shown ? `${shown.path}:${shown.line}` : "(unanchored)"}
                      </span>
                      {replies > 0 && (
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
                          <MessageSquareIcon className="size-3" />
                          {replies}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
