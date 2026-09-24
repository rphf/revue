import { useEffect, useState } from "react";
import { CircleAlertIcon, GitCommitVerticalIcon } from "lucide-react";
import { api, errorMessage } from "../api";
import type { History, HistoryCommit, Thread } from "../types";
import { excerpt } from "@/lib/text";
import { branchLabel, locationLabel } from "@/lib/threads";
import { formatDateTime, timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import LoadingBlocks from "./LoadingBlocks";

const PAGE = 200;

type HistoryFilter = "all" | "resolved" | "unresolved";
const FILTERS: HistoryFilter[] = ["all", "resolved", "unresolved"];

const matches = (t: Thread, f: HistoryFilter) =>
  f === "all" || (f === "resolved") === t.resolved;

export interface HistoryViewProps {
  branch: string;
  // Opens an archived thread on its snapshot.
  onOpen: (thread: Thread) => void;
  activeId?: number | null;
  // Bumped when threads were archived or brought back, to refetch.
  signal: number;
}

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; history: History };

// A branch's past conversations: its commits, newest first, with the
// threads that landed in each one, as they were when archived: resolved
// or not. Commits without threads fold to one line, so the list still
// reads like the branch's log.
export default function HistoryView({
  branch,
  onOpen,
  activeId,
  signal,
}: HistoryViewProps) {
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [state, setState] = useState<HistoryState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    api.getHistory(branch, limit).then(
      (history) => {
        if (!cancelled) setState({ status: "ready", history });
      },
      (e: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [branch, limit, signal]);

  if (state.status === "loading") {
    return (
      <LoadingBlocks
        className="flex-1 p-3"
        label="Loading history…"
        bars={["h-4 w-3/4", "h-10 w-full", "h-4 w-2/3", "h-10 w-full"]}
      />
    );
  }
  if (state.status === "error") {
    return (
      <p
        className="flex items-center gap-2 p-4 text-sm text-destructive"
        role="alert"
      >
        <CircleAlertIcon className="size-4" />
        {state.message}
      </p>
    );
  }
  const { history } = state;
  const all = history.commits.flatMap((c) => c.threads);
  const counts: Record<HistoryFilter, number> = {
    all: all.length,
    resolved: all.filter((t) => t.resolved).length,
    unresolved: all.filter((t) => !t.resolved).length,
  };
  const commits = history.commits
    .map((c) => ({
      ...c,
      threads: c.threads.filter((t) => matches(t, filter)),
    }))
    .filter((c) => filter === "all" || c.threads.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-view">
      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as HistoryFilter)}
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
      {counts.all === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No archived threads on {branchLabel(history.branch)} yet. Threads land
          here once their code is committed.
        </p>
      ) : commits.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No {filter} threads in the history of {branchLabel(history.branch)}.
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ol className="divide-y">
            {commits.map((c) => (
              <CommitRow
                key={c.hash}
                commit={c}
                activeId={activeId}
                onOpen={onOpen}
              />
            ))}
          </ol>
          {history.more && filter === "all" && (
            <div className="p-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="w-full"
                onClick={() => setLimit((n) => n + PAGE)}
              >
                Load older commits
              </Button>
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
}

function CommitRow({
  commit,
  activeId,
  onOpen,
}: {
  commit: HistoryCommit;
  activeId?: number | null;
  onOpen: (thread: Thread) => void;
}) {
  const quiet = commit.threads.length === 0;
  return (
    <li data-testid={`history-commit-${commit.hash.slice(0, 7)}`}>
      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 text-xs",
          quiet ? "text-muted-foreground" : "bg-muted/40",
        )}
      >
        <GitCommitVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono">{commit.hash.slice(0, 7)}</span>
        <span className={cn("truncate", !quiet && "font-medium")}>
          {commit.missing
            ? "Commit no longer in the repository"
            : commit.subject}
        </span>
        {!commit.onBranch && !commit.missing && (
          <span
            className="shrink-0 text-renamed"
            title="A rebase or amend rewrote this commit"
          >
            · rewritten
          </span>
        )}
        {commit.date && !commit.missing && (
          <span
            className="ml-auto shrink-0"
            title={formatDateTime(commit.date)}
          >
            {timeAgo(commit.date)}
          </span>
        )}
      </div>
      {!quiet && (
        <ul className="divide-y border-t">
          {commit.threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full flex-col gap-1 px-3 py-2 pl-8 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                  t.id === activeId && "bg-muted",
                )}
                data-testid={`history-thread-${t.id}`}
                onClick={() => onOpen(t)}
              >
                <span className="line-clamp-2 text-sm leading-snug">
                  {excerpt(t.comments[0]?.body ?? "")}
                </span>
                <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">
                    {locationLabel(t.path, t.line)}
                  </span>
                  {!t.resolved && (
                    <span className="ml-auto shrink-0 text-renamed">
                      unresolved
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
