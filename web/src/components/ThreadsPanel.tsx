import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronRightIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  XIcon,
} from "lucide-react";
import type { Thread, ThreadPosition } from "../types";
import type { Round } from "@/lib/rounds";
import { excerpt } from "@/lib/text";
import { formatDateTime, timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type PanelFilter = "all" | "live" | "outdated" | "resolved";
type ThreadState = Exclude<PanelFilter, "all">;

const FILTERS: PanelFilter[] = ["all", "live", "outdated", "resolved"];

const stateDot: Record<ThreadState, string> = {
  live: "bg-added",
  outdated: "bg-renamed",
  resolved: "bg-muted-foreground/50",
};

export interface ThreadsPanelProps {
  // Every thread, grouped by the round it was last active in.
  rounds: Round[];
  // Where each thread sits in the diff on screen; a thread without a
  // live position is outdated for this diff.
  positions: ReadonlyMap<number, ThreadPosition>;
  onJump: (thread: Thread, position: ThreadPosition | undefined) => void;
  // The thread the page is showing, marked in the list.
  activeId?: number | null;
  onClose: () => void;
  // Pinned under the list: the composer for the next send.
  footer?: ReactNode;
}

interface Row {
  thread: Thread;
  position: ThreadPosition | undefined;
  state: ThreadState;
}

// Every thread with live/outdated/resolved filters relative to the
// shown diff, in one collapsible section per round: what is not sent
// yet, then each Send newest first, the way `revue feedback --since`
// reads the conversation. The unsent round and the latest Send start
// open. A thread whose code is gone stays reachable here and opens on
// the file as it was. Rows lead with the opening comment, which is what
// a reviewer remembers a thread by; the file position is secondary.
export default function ThreadsPanel({
  rounds,
  positions,
  onJump,
  activeId,
  onClose,
  footer,
}: ThreadsPanelProps) {
  const [filter, setFilter] = useState<PanelFilter>("all");
  // Sections the reviewer opened or closed; the rest follow the default.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  const sections = useMemo(
    () =>
      rounds.map((round) => ({
        round,
        rows: round.threads.map((t): Row => {
          const position = positions.get(t.id);
          const state: ThreadState = t.resolved
            ? "resolved"
            : position?.state === "live"
              ? "live"
              : "outdated";
          return { thread: t, position, state };
        }),
      })),
    [rounds, positions],
  );
  const allRows = sections.flatMap((s) => s.rows);
  const count = (s: PanelFilter) => allRows.filter((r) => r.state === s).length;
  const latestSend = rounds.find((r) => r.kind === "send")?.key;

  const visibleSections = sections
    .map((s) => ({
      ...s,
      rows: s.rows.filter((r) => filter === "all" || r.state === filter),
    }))
    .filter((s) => s.rows.length > 0);

  const isOpen = (round: Round, rows: Row[]) =>
    toggled.get(round.key) ??
    (round.kind === "unsent" ||
      round.key === latestSend ||
      rows.some((r) => r.thread.id === activeId));
  const toggle = (key: string, open: boolean) =>
    setToggled((prev) => new Map(prev).set(key, !open));

  return (
    <div className="flex h-full flex-col" data-testid="threads-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquareTextIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">Threads</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {allRows.length}
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
      {visibleSections.length === 0 ? (
        <p className="min-h-0 flex-1 p-4 text-sm text-muted-foreground">
          No {filter === "all" ? "" : filter + " "}threads
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {visibleSections.map(({ round, rows }) => {
            const open = isOpen(round, rows);
            return (
              <section
                key={round.key}
                className="border-b"
                data-testid={`panel-round-${round.key}`}
              >
                <RoundHeader
                  round={round}
                  count={rows.length}
                  open={open}
                  onToggle={() => toggle(round.key, open)}
                />
                {open && (
                  <ul className="divide-y border-t">
                    {rows.map((row) => (
                      <ThreadRow
                        key={row.thread.id}
                        row={row}
                        active={row.thread.id === activeId}
                        onJump={onJump}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </ScrollArea>
      )}
      {footer}
    </div>
  );
}

function RoundHeader({
  round,
  count,
  open,
  onToggle,
}: {
  round: Round;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const note = round.kind === "send" ? excerpt(round.send.note) : "";
  return (
    <button
      type="button"
      className="sticky top-0 z-10 flex w-full flex-col gap-0.5 bg-sidebar px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="flex w-full items-center gap-1.5 text-xs">
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium">
          {round.kind === "send" ? `Round ${round.number}` : "Not sent yet"}
        </span>
        {round.kind === "send" && (
          <span
            className="text-muted-foreground"
            title={formatDateTime(round.send.createdAt)}
          >
            · {timeAgo(round.send.createdAt)}
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {count}
        </span>
      </span>
      {note && (
        <span className="truncate pl-5 text-xs text-muted-foreground">
          {note}
        </span>
      )}
    </button>
  );
}

function ThreadRow({
  row: { thread, position, state },
  active,
  onJump,
}: {
  row: Row;
  active: boolean;
  onJump: ThreadsPanelProps["onJump"];
}) {
  const shown =
    position?.state === "live"
      ? { path: position.path, line: position.line }
      : { path: thread.path, line: thread.line };
  const first = thread.comments[0];
  const last = thread.comments[thread.comments.length - 1];
  const replies = Math.max(0, thread.comments.length - 1);
  const drafts = thread.comments.filter((c) => c.draft).length;
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full flex-col gap-1.5 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
          state === "resolved" && "opacity-70",
          active && "bg-muted",
        )}
        aria-current={active || undefined}
        data-testid={`panel-thread-${thread.id}`}
        onClick={() => onJump(thread, position)}
      >
        <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", stateDot[state])} />
          <span className="capitalize">{state}</span>
          {state === "outdated" && <span>· not in this diff</span>}
          {drafts > 0 && (
            <span className="text-renamed">
              · {drafts === 1 ? "draft" : `${drafts} drafts`}
            </span>
          )}
          {last && (
            <span className="ml-auto shrink-0">{timeAgo(last.createdAt)}</span>
          )}
        </span>
        <span className="line-clamp-2 text-sm leading-snug text-foreground">
          {first ? excerpt(first.body) : ""}
        </span>
        <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">
            {shown.path}:{shown.line}
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
}
