import { useState } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleCheckIcon,
  HistoryIcon,
  ReplyIcon,
  UserIcon,
} from "lucide-react";
import { api } from "../api";
import type { AnchorState, ReviewState, Thread as ThreadType } from "../types";
import { formatDateTime, timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import CommentForm from "./CommentForm";
import Markdown from "./Markdown";

export interface ThreadProps {
  thread: ThreadType;
  anchorState?: AnchorState;
  reviewState: ReviewState;
  onChanged: () => void;
  onJumpToOrigin?: (roundSeq: number) => void;
}

// A comment thread: comments in order with author roles, draft
// affordances (edit/delete before submit), reply, and reviewer-only
// resolve (R4, R5, R6).
export default function Thread({
  thread,
  anchorState,
  reviewState,
  onChanged,
  onJumpToOrigin,
}: ThreadProps) {
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = (op: Promise<unknown>) =>
    op.then(
      () => {
        setActionError(null);
        onChanged();
      },
      (e) => setActionError(e instanceof Error ? e.message : String(e)),
    );

  const deleteComment = (id: number) => {
    setDeletingId(null);
    void run(api.deleteComment(id));
  };

  const outdated = anchorState === "outdated";

  return (
    <div
      className={cn("annotation-card", thread.resolved && "opacity-75")}
      data-testid={`thread-${thread.id}`}
    >
      {(thread.resolved || outdated) && (
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
          {thread.resolved && (
            <Badge variant="outline" className="border-added/40 text-added">
              <CheckIcon />
              Resolved
            </Badge>
          )}
          {outdated && (
            <Badge
              asChild
              variant="outline"
              className="border-renamed/40 text-renamed hover:bg-renamed/10"
            >
              <button
                type="button"
                title="The code this thread was anchored to changed; view it in its original round"
                onClick={() => onJumpToOrigin?.(thread.originRoundSeq)}
              >
                <HistoryIcon />
                Outdated · round {thread.originRoundSeq}
              </button>
            </Badge>
          )}
        </div>
      )}
      <ul className="divide-y">
        {thread.comments.map((c) => {
          const agent = c.authorRole === "agent";
          return (
            <li
              key={c.id}
              className="px-3 py-2.5"
              data-testid={`comment-${c.id}`}
            >
              <div className="mb-1 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full",
                    agent
                      ? "bg-agent/15 text-agent"
                      : "bg-muted text-foreground",
                  )}
                  aria-hidden="true"
                >
                  {agent ? (
                    <BotIcon className="size-3" />
                  ) : (
                    <UserIcon className="size-3" />
                  )}
                </span>
                <span
                  className={cn(
                    "font-medium capitalize",
                    agent && "text-agent",
                  )}
                >
                  {c.authorRole}
                </span>
                {c.createdAt && (
                  <span
                    className="whitespace-nowrap text-muted-foreground"
                    title={formatDateTime(c.createdAt)}
                  >
                    {timeAgo(c.createdAt)}
                  </span>
                )}
                {c.draft && (
                  <Badge
                    variant="outline"
                    className="h-4 border-renamed/40 px-1.5 text-[10px] text-renamed"
                  >
                    Draft
                  </Badge>
                )}
                {c.draft &&
                  c.authorRole === "reviewer" &&
                  (deletingId === c.id ? (
                    <span
                      className="ml-auto inline-flex items-center gap-1 text-muted-foreground"
                      role="status"
                    >
                      Delete this draft?
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setDeletingId(null)}
                      >
                        Keep
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="xs"
                        onClick={() => deleteComment(c.id)}
                      >
                        Delete
                      </Button>
                    </span>
                  ) : (
                    <span className="ml-auto inline-flex items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setEditingId(c.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDeletingId(c.id)}
                      >
                        Delete
                      </Button>
                    </span>
                  ))}
              </div>
              {editingId === c.id ? (
                <CommentForm
                  initial={c.body}
                  submitLabel="Update"
                  onSubmit={async (body) => {
                    await api.editComment(c.id, body);
                    setEditingId(null);
                    onChanged();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <Markdown source={c.body} />
              )}
            </li>
          );
        })}
      </ul>
      {actionError && (
        <p className="px-3 pb-2 text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1 border-t bg-muted/30 px-2 py-1.5">
        {replying ? (
          <div className="w-full p-1">
            <CommentForm
              placeholder="Reply"
              submitLabel="Reply"
              onSubmit={async (body) => {
                await api.reply(thread.id, body);
                setReplying(false);
                onChanged();
              }}
              onCancel={() => setReplying(false)}
            />
          </div>
        ) : (
          <>
            {reviewState !== "closed" && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setReplying(true)}
              >
                <ReplyIcon />
                Reply
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                void run(api.resolveThread(thread.id, !thread.resolved))
              }
            >
              <CircleCheckIcon />
              {thread.resolved ? "Unresolve" : "Resolve"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
