import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  XIcon,
} from "lucide-react";
import { api } from "../api";
import type { Branch, Thread, ThreadPosition } from "../types";
import { excerpt } from "@/lib/text";
import { branchLabel, locationLabel } from "@/lib/threads";
import { timeAgo } from "@/lib/time";
import { groupByTurn, sendCount, turnLabel, type Turn } from "@/lib/turns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import HistoryView from "./HistoryView";

type PanelMode = "current" | "history";
type PanelFilter = "all" | "live" | "outdated" | "resolved";
type ThreadState = Exclude<PanelFilter, "all">;

const FILTERS: PanelFilter[] = ["all", "live", "outdated", "resolved"];

const stateDot: Record<ThreadState, string> = {
  live: "bg-added",
  outdated: "bg-renamed",
  resolved: "bg-muted-foreground/50",
};

const NO_POSITIONS: ReadonlyMap<number, ThreadPosition> = new Map();
const NO_THREADS: Thread[] = [];

export interface ThreadsPanelProps {
  // The checkout's threads, grouped in the panel by whose turn it is.
  threads: Thread[];
  // Where each thread sits in the diff on screen; a thread without a
  // live position is outdated for this diff.
  positions: ReadonlyMap<number, ThreadPosition>;
  onJump: (thread: Thread, position: ThreadPosition | undefined) => void;
  // Opens a thread that is not in this checkout (another branch's, or an
  // archived one) on its snapshot.
  onOpenThread?: (thread: Thread) => void;
  // The thread the page is showing, marked in the list.
  activeId?: number | null;
  onClose: () => void;
  // Pinned under the list: the composer for the next send.
  footer?: ReactNode;
  // Threads whose code landed and that are not archived, offered once
  // per commit.
  landed?: { head: string; count: number } | null;
  onArchiveLanded?: () => void;
  onDismissLanded?: () => void;
  autoArchive?: boolean;
  onAutoArchiveChange?: (on: boolean) => void;
  onArchive?: (which: "resolved" | "all") => void;
  archiveError?: string | null;
  // Bumped when threads changed anywhere, to refetch the branch list,
  // another branch's threads, and History.
  signal?: number;
}

interface Row {
  thread: Thread;
  position: ThreadPosition | undefined;
  state: ThreadState;
}

// Threads of a branch in two modes. Current: every open thread with
// live/outdated/resolved filters relative to the shown diff, in one
// collapsible section per turn (yours, drafts, the agent's, resolved).
// History: the threads archived on the branch, under the
// commit their code landed in. The branch picker serves both; another
// branch's threads are not in this diff and open on their snapshot.
export default function ThreadsPanel({
  threads: checkoutThreads,
  positions: checkoutPositions,
  onJump,
  onOpenThread,
  activeId,
  onClose,
  footer,
  landed,
  onArchiveLanded,
  onDismissLanded,
  autoArchive = false,
  onAutoArchiveChange,
  onArchive,
  archiveError,
  signal = 0,
}: ThreadsPanelProps) {
  const [mode, setMode] = useState<PanelMode>("current");
  const [filter, setFilter] = useState<PanelFilter>("all");
  // undefined follows the branch checked out.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [branches, setBranches] = useState<{
    current: string;
    branches: Branch[];
  } | null>(null);
  const [other, setOther] = useState<{ branch: string; threads: Thread[] }>();
  // Sections the reviewer opened or closed; the rest follow the default.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    api.getBranches().then(
      (b) => {
        if (!cancelled) setBranches(b);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [signal]);
  const current = branches?.current;
  const branch = picked ?? current;
  const viewingOther = picked !== undefined && picked !== current;

  useEffect(() => {
    if (!viewingOther || mode !== "current") return;
    let cancelled = false;
    api.listThreads(picked).then(
      (r) => {
        if (!cancelled) setOther({ branch: picked, threads: r.threads });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [viewingOther, picked, mode, signal]);

  const threads = viewingOther
    ? other?.branch === picked
      ? other.threads
      : NO_THREADS
    : checkoutThreads;
  const positions = viewingOther ? NO_POSITIONS : checkoutPositions;
  const jump = (thread: Thread, position: ThreadPosition | undefined) =>
    viewingOther ? onOpenThread?.(thread) : onJump(thread, position);

  const { sections, counts } = useMemo(() => {
    const counts: Record<PanelFilter, number> = {
      all: 0,
      live: 0,
      outdated: 0,
      resolved: 0,
    };
    const sections = groupByTurn(threads).map(({ turn, threads }) => ({
      turn,
      rows: threads.map((t): Row => {
        const position = positions.get(t.id);
        const state: ThreadState = t.resolved
          ? "resolved"
          : position?.state === "live"
            ? "live"
            : "outdated";
        counts.all++;
        counts[state]++;
        return { thread: t, position, state };
      }),
    }));
    return { sections, counts };
  }, [threads, positions]);

  const visibleSections = sections
    .map((s) => ({
      ...s,
      rows: s.rows.filter((r) => filter === "all" || r.state === filter),
    }))
    .filter((s) => s.rows.length > 0);

  // Your turn and drafts are open, and the first section when neither
  // shows, so the list never opens all folded.
  const isOpen = (turn: Turn, rows: Row[], index: number) =>
    toggled.get(turn) ??
    (turn === "yours" ||
      turn === "drafts" ||
      index === 0 ||
      rows.some((r) => r.thread.id === activeId));
  const toggle = (key: string, open: boolean) =>
    setToggled((prev) => new Map(prev).set(key, !open));

  const choices = branches?.branches ?? [];

  return (
    <div className="flex h-full flex-col" data-testid="threads-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquareTextIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">Threads</span>
        {mode === "current" && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {counts.all}
          </span>
        )}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          className="ml-auto"
          value={mode}
          onValueChange={(v) => {
            if (v) setMode(v as PanelMode);
          }}
          aria-label="Threads or history"
        >
          <ToggleGroupItem value="current" className="h-7 px-2.5 text-xs">
            Current
          </ToggleGroupItem>
          <ToggleGroupItem value="history" className="h-7 px-2.5 text-xs">
            History
          </ToggleGroupItem>
        </ToggleGroup>
        {onArchive && (
          <PanelMenu
            onArchive={onArchive}
            bulkDisabled={viewingOther}
            autoArchive={autoArchive}
            onAutoArchiveChange={onAutoArchiveChange}
          />
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close threads"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <label htmlFor="threads-branch" className="text-muted-foreground">
          Branch
        </label>
        <select
          id="threads-branch"
          className="h-7 min-w-0 flex-1 truncate rounded-md border bg-background px-2 font-mono text-xs"
          value={branch ?? ""}
          disabled={branches === null}
          onChange={(e) =>
            setPicked(e.target.value === current ? undefined : e.target.value)
          }
        >
          {choices.map((b) => (
            <option key={b.name} value={b.name}>
              {branchLabel(b.name)}
              {b.name === current ? " (checked out)" : ""}
            </option>
          ))}
        </select>
      </div>
      {mode === "history" ? (
        branch !== undefined && (
          <HistoryView
            key={branch}
            branch={branch}
            onOpen={(t) => onOpenThread?.(t)}
            activeId={activeId}
            signal={signal}
          />
        )
      ) : (
        <>
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
                      {counts[f]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {!viewingOther && landed && landed.count > 0 && (
            <LandedOffer
              landed={landed}
              onArchive={onArchiveLanded}
              onDismiss={onDismissLanded}
              autoArchive={autoArchive}
              onAutoArchiveChange={onAutoArchiveChange}
            />
          )}
          {archiveError && (
            <p
              className="border-b px-3 py-1.5 text-xs text-destructive"
              role="alert"
            >
              {archiveError}
            </p>
          )}
          {viewingOther && (
            <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              Threads of {branchLabel(picked)}: not in this diff, they open on
              the code they were written on.
            </p>
          )}
          {visibleSections.length === 0 ? (
            <p className="min-h-0 flex-1 p-4 text-sm text-muted-foreground">
              No {filter === "all" ? "" : filter + " "}threads
            </p>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              {visibleSections.map(({ turn, rows }, index) => {
                const open = isOpen(turn, rows, index);
                return (
                  <section
                    key={turn}
                    className="border-b"
                    data-testid={`panel-turn-${turn}`}
                  >
                    <TurnHeader
                      turn={turn}
                      count={rows.length}
                      open={open}
                      onToggle={() => toggle(turn, open)}
                    />
                    {open && (
                      <ul className="divide-y border-t">
                        {rows.map((row) => (
                          <ThreadRow
                            key={row.thread.id}
                            row={row}
                            active={row.thread.id === activeId}
                            onJump={jump}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </ScrollArea>
          )}
        </>
      )}
      {footer}
    </div>
  );
}

function AutoArchiveToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs select-none">
      <Checkbox
        className="size-3.5 bg-background [&_svg]:size-3!"
        checked={checked}
        onCheckedChange={(v) => onChange?.(v === true)}
        aria-label="Archive landed threads automatically"
      />
      Archive landed threads automatically
    </label>
  );
}

// The offer that follows a commit: its threads landed, archive them in
// one click, or not now (until the next commit).
function LandedOffer({
  landed,
  onArchive,
  onDismiss,
  autoArchive,
  onAutoArchiveChange,
}: {
  landed: { head: string; count: number };
  onArchive?: () => void;
  onDismiss?: () => void;
  autoArchive: boolean;
  onAutoArchiveChange?: (on: boolean) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 border-b bg-added/10 px-3 py-2"
      role="status"
      data-testid="landed-offer"
    >
      <p className="text-xs">
        {landed.count === 1 ? "1 thread" : `${landed.count} threads`} landed in{" "}
        <span className="font-mono">{landed.head.slice(0, 7)}</span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="xs" onClick={onArchive}>
          <ArchiveIcon />
          Archive
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          Not now
        </Button>
      </div>
      <AutoArchiveToggle checked={autoArchive} onChange={onAutoArchiveChange} />
    </div>
  );
}

function PanelMenu({
  onArchive,
  bulkDisabled,
  autoArchive,
  onAutoArchiveChange,
}: {
  onArchive: (which: "resolved" | "all") => void;
  // Bulk archiving acts on the checkout's threads only.
  bulkDisabled: boolean;
  autoArchive: boolean;
  onAutoArchiveChange?: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (which: "resolved" | "all") => {
    setOpen(false);
    onArchive(which);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Thread actions">
          <EllipsisIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-1 p-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          disabled={bulkDisabled}
          onClick={() => pick("resolved")}
        >
          <ArchiveIcon />
          Archive resolved and outdated
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          disabled={bulkDisabled}
          onClick={() => pick("all")}
        >
          <ArchiveIcon />
          Archive all on this branch
        </Button>
        <div className="border-t px-2 pt-2 pb-1">
          <AutoArchiveToggle
            checked={autoArchive}
            onChange={onAutoArchiveChange}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TurnHeader({
  turn,
  count,
  open,
  onToggle,
}: {
  turn: Turn;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="sticky top-0 z-10 flex w-full items-center gap-1.5 bg-sidebar px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
      <span className="font-medium">{turnLabel[turn]}</span>
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        {count}
      </span>
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
  const sends = sendCount(thread);
  const answer = last !== first && last?.authorRole === "agent" ? last : null;
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
          {first?.authorRole === "agent" && (
            <span className="text-agent">· agent note</span>
          )}
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
        {answer && (
          <span className="line-clamp-2 border-l-2 border-agent/40 pl-2 text-xs leading-snug text-muted-foreground">
            <span className="text-agent">agent:</span> {excerpt(answer.body)}
          </span>
        )}
        <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
          <span className="mr-auto truncate font-mono">
            {locationLabel(shown.path, shown.line)}
          </span>
          {sends > 0 && (
            <span
              className="shrink-0 tabular-nums"
              title={sends === 1 ? "Sent once" : `Went through ${sends} sends`}
            >
              R{sends}
            </span>
          )}
          {replies > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <MessageSquareIcon className="size-3" />
              {replies}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
