import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  BotIcon,
  ChevronRightIcon,
  EllipsisIcon,
  ListFilterIcon,
  MessageSquareTextIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { api } from "../api";
import type { Branch, Comment, Thread, ThreadPosition } from "../types";
import { excerpt } from "@/lib/text";
import {
  FILTERS as REFINES,
  SORTS,
  filterLabel,
  loadOrder,
  matches,
  newReply,
  saveOrder,
  shownAt,
  sortLabel,
  sortRows,
  type ThreadFilter,
  type ThreadOrder,
} from "@/lib/threadOrder";
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
  // commentId: the comment to land on, the thread as a whole without.
  onJump: (
    thread: Thread,
    position: ThreadPosition | undefined,
    commentId?: number,
  ) => void;
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
  // The agent's latest comment when it came after the last send.
  fresh: Comment | undefined;
}

// Threads of a branch in two modes. Current: every open thread with
// live/outdated/resolved filters relative to the shown diff, in one
// collapsible section per turn (yours, drafts, the agent's, resolved),
// sorted and narrowed by the reviewer's choice.
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
  const [order, setOrder] = useState<ThreadOrder>(loadOrder);
  const changeOrder = (next: ThreadOrder) => {
    setOrder(next);
    saveOrder(next);
  };
  // When the reviewer last sent: agent comments after it are new.
  const [lastSendAt, setLastSendAt] = useState<string | null>(null);

  // The checkout's threads reload after every send.
  useEffect(() => {
    let cancelled = false;
    api.listSends().then(
      (r) => {
        if (!cancelled) setLastSendAt(r.sends.at(-1)?.createdAt ?? null);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [checkoutThreads]);

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
  const jump: ThreadsPanelProps["onJump"] = (thread, position, commentId) =>
    viewingOther ? onOpenThread?.(thread) : onJump(thread, position, commentId);

  const { sections, counts } = useMemo(() => {
    const counts: Record<PanelFilter, number> = {
      all: 0,
      live: 0,
      outdated: 0,
      resolved: 0,
    };
    const filters = new Set(order.filters);
    const shown = threads.filter((t) => matches(t, filters, lastSendAt));
    const sections = groupByTurn(shown).map(({ turn, threads }) => ({
      turn,
      rows: sortRows(
        threads.map((t): Row => {
          const position = positions.get(t.id);
          const state: ThreadState = t.resolved
            ? "resolved"
            : position?.state === "live"
              ? "live"
              : "outdated";
          counts.all++;
          counts[state]++;
          return { thread: t, position, state, fresh: newReply(t, lastSendAt) };
        }),
        order.sort,
      ),
    }));
    return { sections, counts };
  }, [threads, positions, order, lastSendAt]);

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
          <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
            <label htmlFor="threads-sort" className="text-muted-foreground">
              Sort
            </label>
            <select
              id="threads-sort"
              className="h-7 min-w-0 flex-1 truncate rounded-md border bg-background px-2 text-xs"
              value={order.sort}
              onChange={(e) =>
                changeOrder({
                  ...order,
                  sort: e.target.value as ThreadOrder["sort"],
                })
              }
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {sortLabel[s]}
                </option>
              ))}
            </select>
            <FilterMenu
              filters={order.filters}
              onChange={(filters) => changeOrder({ ...order, filters })}
            />
          </div>
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
              {order.filters.length > 0 && " match the filters"}
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

// Narrows the list to threads that pass every checked filter.
function FilterMenu({
  filters,
  onChange,
}: {
  filters: ThreadFilter[];
  onChange: (filters: ThreadFilter[]) => void;
}) {
  const set = (f: ThreadFilter, on: boolean) =>
    onChange(REFINES.filter((g) => (g === f ? on : filters.includes(g))));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={filters.length > 0 ? "secondary" : "ghost"}
          size="xs"
          aria-label="Filter threads"
        >
          <ListFilterIcon />
          Filter
          {filters.length > 0 && (
            <span className="tabular-nums">{filters.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-56 flex-col gap-2 p-3">
        {REFINES.map((f) => (
          <label
            key={f}
            className="flex cursor-pointer items-center gap-2 text-xs select-none"
          >
            <Checkbox
              className="size-3.5 bg-background [&_svg]:size-3!"
              checked={filters.includes(f)}
              onCheckedChange={(v) => set(f, v === true)}
            />
            {filterLabel[f]}
          </label>
        ))}
        {filters.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={() => onChange([])}
          >
            Clear filters
          </Button>
        )}
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
  row,
  active,
  onJump,
}: {
  row: Row;
  active: boolean;
  onJump: ThreadsPanelProps["onJump"];
}) {
  const { thread, position, state, fresh } = row;
  const shown = shownAt(row);
  const first = thread.comments[0];
  const last = thread.comments.at(-1);
  const replies = Math.max(0, thread.comments.length - 1);
  const drafts = thread.comments.filter((c) => c.draft).length;
  const sends = sendCount(thread);
  const stateText =
    state === "outdated" ? "Outdated, not in this diff" : capitalize(state);
  const details = [
    stateText,
    shown.path,
    replies > 0 && (replies === 1 ? "1 reply" : `${replies} replies`),
    sends > 0 && (sends === 1 ? "sent once" : `went through ${sends} sends`),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 flex-col gap-1.5 px-3 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
          state === "resolved" && "opacity-70",
          active && "bg-muted",
        )}
        title={details}
        aria-current={active || undefined}
        data-testid={`panel-thread-${thread.id}`}
        // A new reply is what the row is about: land on it.
        onClick={() => onJump(thread, position, fresh?.id)}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", stateDot[state])}
          />
          <span className="sr-only">{stateText}</span>
          {/* Cut at the start, so the file name and line stay. */}
          <span className="min-w-0 truncate font-mono" dir="rtl">
            <span dir="ltr">{locationLabel(shown.path, shown.line)}</span>
          </span>
          {drafts > 0 && (
            <span className="shrink-0 text-renamed">
              {drafts === 1 ? "draft" : `${drafts} drafts`}
            </span>
          )}
          {last && (
            <span className="ml-auto shrink-0 pl-2">
              {timeAgo(last.createdAt)}
            </span>
          )}
        </span>
        {first && (
          <CommentLine
            comment={first}
            opens
            isNew={fresh === first}
            className="text-sm text-foreground"
          />
        )}
        {last && last !== first && (
          <CommentLine
            comment={last}
            isNew={fresh === last}
            className={cn(
              "text-xs",
              fresh === last ? "text-foreground" : "text-muted-foreground",
            )}
          />
        )}
      </button>
    </li>
  );
}

// One comment of a row on one line: its author's icon, then its start.
function CommentLine({
  comment,
  opens = false,
  isNew,
  className,
}: {
  comment: Comment;
  // The comment that opened the thread: an agent's is a note.
  opens?: boolean;
  isNew: boolean;
  className?: string;
}) {
  const agent = comment.authorRole === "agent";
  const Icon = agent ? BotIcon : UserIcon;
  return (
    <span className={cn("flex w-full min-w-0 items-center gap-2", className)}>
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          agent ? "text-agent" : "text-muted-foreground",
        )}
        aria-hidden="true"
      />
      <span className="sr-only">
        {agent ? (opens ? "agent note: " : "agent: ") : "you: "}
      </span>
      <span className="min-w-0 flex-1 truncate">{excerpt(comment.body)}</span>
      {isNew && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-agent">
          <span className="size-1.5 rounded-full bg-agent" />
          new
        </span>
      )}
    </span>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
