import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  CircleCheckIcon,
  EyeIcon,
  EyeOffIcon,
  MessageSquareIcon,
  ReplyIcon,
  UserIcon,
} from "lucide-react";
import { api, errorMessage } from "../api";
import type {
  AuthorRole,
  Comment as CommentType,
  Thread as ThreadType,
} from "../types";
import { useCommentMinimized, useThreadFold } from "@/lib/folds";
import { excerpt } from "@/lib/text";
import { formatDateTime, timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import CommentForm from "./CommentForm";
import Markdown from "./Markdown";
import { LINE_SCROLL_OFFSET } from "./codeViewStyle";
import { FocusedCommentContext, FocusedThreadContext } from "./threadFocus";

export interface ThreadProps {
  thread: ThreadType;
  onChanged: () => void;
}

// A comment thread: comments in order with author roles, draft
// affordances (edit/delete before send), reply, and reviewer-only
// resolve and archive. An archived thread is read-only but for
// bringing it back. A thread folds to one line; a resolved one starts
// folded, and a jump to a folded one opens it.
export default function Thread({ thread, onChanged }: ThreadProps) {
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const focused = useContext(FocusedThreadContext) === thread.id;
  // A link to one comment outlines that comment instead of the card.
  const focusedComment = useContext(FocusedCommentContext);
  const outlined =
    focused && !thread.comments.some((c) => c.id === focusedComment);
  const archived = Boolean(thread.archivedAt);
  const hasDraft = thread.comments.some((c) => c.draft);
  const [folded, setFolded] = useThreadFold(
    thread.id,
    thread.resolved && !hasDraft,
  );
  useEffect(() => {
    if (focused) setFolded(false);
  }, [focused, setFolded]);

  const run = (op: Promise<unknown>) =>
    op.then(
      () => {
        setActionError(null);
        onChanged();
      },
      (e) => setActionError(errorMessage(e)),
    );

  const deleteComment = (id: number) => {
    setDeletingId(null);
    void run(api.deleteComment(id));
  };

  if (folded) {
    const first = thread.comments[0];
    const replies = thread.comments.length - 1;
    return (
      <div
        className={cn(
          "annotation-card",
          thread.resolved && "opacity-75",
          focused && "outline-2 outline-offset-2 outline-primary",
        )}
        data-testid={`thread-${thread.id}`}
        data-thread-id={thread.id}
        data-folded
      >
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
          aria-expanded={false}
          aria-label="Open the thread"
          onClick={() => setFolded(false)}
        >
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          {first && <Avatar role={first.authorRole} />}
          {/* Contained, so the line never widens the card: in the split
              view, a wide card would push the two sides off 50/50. */}
          <span className="min-w-0 flex-1 truncate [contain:inline-size]">
            {first ? excerpt(first.body) : ""}
          </span>
          {thread.resolved && (
            <span className="inline-flex shrink-0 items-center gap-1 text-added">
              <CheckIcon className="size-3" />
              Resolved
            </span>
          )}
          {archived && (
            <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <ArchiveIcon className="size-3" />
              Archived
            </span>
          )}
          {replies > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums">
              <MessageSquareIcon className="size-3" />
              {replies}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "annotation-card",
        thread.resolved && "opacity-75",
        outlined && "outline-2 outline-offset-2 outline-primary",
      )}
      data-testid={`thread-${thread.id}`}
      data-thread-id={thread.id}
      data-focused={focused || undefined}
    >
      {(thread.resolved || archived) && (
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
          {thread.resolved && (
            <Badge variant="outline" className="border-added/40 text-added">
              <CheckIcon />
              Resolved
            </Badge>
          )}
          {archived && (
            <Badge variant="outline" className="text-muted-foreground">
              <ArchiveIcon />
              Archived
            </Badge>
          )}
        </div>
      )}
      <ul className="divide-y">
        {thread.comments.map((c, index) => (
          <CommentItem
            key={c.id}
            comment={c}
            actions={
              c.draft &&
              c.authorRole === "reviewer" &&
              (deletingId === c.id ? (
                <span
                  className="inline-flex items-center gap-1 text-muted-foreground"
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
                <span className="inline-flex items-center gap-0.5">
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
              ))
            }
            fold={
              index === 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label="Fold the thread"
                  title="Fold the thread"
                  onClick={() => setFolded(true)}
                >
                  <ChevronsDownUpIcon />
                </Button>
              )
            }
          >
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
          </CommentItem>
        ))}
      </ul>
      {actionError && (
        <p className="px-3 pb-2 text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1 border-t bg-muted/30 px-2 py-1.5">
        {archived ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void run(api.unarchiveThread(thread.id))}
          >
            <ArchiveRestoreIcon />
            Unarchive
          </Button>
        ) : replying ? (
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
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setReplying(true)}
            >
              <ReplyIcon />
              Reply
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                // Resolving folds the thread and unresolving opens it,
                // whatever was chosen for it before.
                const resolving = !thread.resolved;
                void run(
                  api
                    .resolveThread(thread.id, resolving)
                    .then(() => setFolded(resolving)),
                );
              }}
            >
              <CircleCheckIcon />
              {thread.resolved ? "Unresolve" : "Resolve"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={hasDraft}
              title={
                hasDraft
                  ? "Send or delete the draft before archiving"
                  : "Hide this thread; it stays in History"
              }
              onClick={() => void run(api.archiveThreads({ ids: [thread.id] }))}
            >
              <ArchiveIcon />
              Archive
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Avatar({ role }: { role: AuthorRole }) {
  const agent = role === "agent";
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full",
        agent ? "bg-agent/15 text-agent" : "bg-muted text-foreground",
      )}
      aria-hidden="true"
    >
      {agent ? <BotIcon className="size-3" /> : <UserIcon className="size-3" />}
    </span>
  );
}

// One comment: its author, time, and body. A sent comment minimizes to
// one line that names only its author, as GitHub hides a comment.
function CommentItem({
  comment: c,
  actions,
  fold,
  children,
}: {
  comment: CommentType;
  // Draft edit and delete, before the minimize button.
  actions?: ReactNode;
  // The thread's fold button, on its first comment.
  fold?: ReactNode;
  children: ReactNode;
}) {
  const [minimized, setMinimized] = useCommentMinimized(c.id);
  const focused = useContext(FocusedCommentContext) === c.id;
  const ref = useRef<HTMLLIElement>(null);
  // The page scrolls the diff to the thread's line first; two frames
  // later, the comment's top comes into view. Its top, not its nearest
  // edge: a reply taller than the pane would show its end.
  useEffect(() => {
    if (!focused) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        ref.current?.scrollIntoView({ block: "start" }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [focused]);
  const agent = c.authorRole === "agent";
  const author = (
    <>
      <Avatar role={c.authorRole} />
      <span className={cn("font-medium capitalize", agent && "text-agent")}>
        {c.authorRole}
      </span>
    </>
  );

  // A link to a minimized comment shows it while it stays focused.
  if (minimized && !c.draft && !focused) {
    return (
      <li
        className="flex min-h-6 items-center gap-2 px-3 py-1.5 text-xs"
        data-testid={`comment-${c.id}`}
        data-comment-id={c.id}
        data-minimized
      >
        {author}
        <span className="text-muted-foreground">minimized</span>
        <span className="ml-auto inline-flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setMinimized(false)}
          >
            <EyeIcon />
            Show
          </Button>
          {fold}
        </span>
      </li>
    );
  }

  return (
    <li
      ref={ref}
      className={cn(
        "px-3 py-2.5",
        focused && "rounded-md outline-2 -outline-offset-2 outline-primary",
      )}
      data-testid={`comment-${c.id}`}
      data-comment-id={c.id}
      data-focused={focused || undefined}
      // A jump puts the comment's top below the sticky file header, the
      // same room a jump to a line keeps.
      style={{ scrollMarginTop: LINE_SCROLL_OFFSET }}
    >
      <div className="mb-1 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {author}
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
        <span className="ml-auto inline-flex items-center gap-0.5">
          {actions}
          {!c.draft && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label="Minimize the comment"
              title="Minimize the comment"
              onClick={() => setMinimized(true)}
            >
              <EyeOffIcon />
            </Button>
          )}
          {fold}
        </span>
      </div>
      {children}
    </li>
  );
}
