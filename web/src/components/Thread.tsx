import { useState } from "react";
import { api } from "../api";
import type { AnchorState, ReviewState, Thread as ThreadType } from "../types";
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

  return (
    <div
      className={`thread${thread.resolved ? " thread-resolved" : ""}`}
      data-testid={`thread-${thread.id}`}
    >
      <div className="thread-header">
        {thread.resolved && (
          <span className="chip chip-resolved">Resolved</span>
        )}
        {anchorState === "outdated" && (
          <button
            type="button"
            className="chip chip-outdated"
            title="The code this thread was anchored to changed; view it in its original round"
            onClick={() => onJumpToOrigin?.(thread.originRoundSeq)}
          >
            Outdated · round {thread.originRoundSeq}
          </button>
        )}
      </div>
      <ul className="comment-list">
        {thread.comments.map((c) => (
          <li key={c.id} className="comment" data-testid={`comment-${c.id}`}>
            <div className="comment-meta">
              <span className={`role role-${c.authorRole}`}>
                {c.authorRole}
              </span>
              {c.draft && <span className="chip chip-draft">Draft</span>}
              {c.draft &&
                c.authorRole === "reviewer" &&
                (deletingId === c.id ? (
                  <span
                    className="comment-actions confirm-inline"
                    role="status"
                  >
                    Delete this draft?
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setDeletingId(null)}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="link-btn link-danger"
                      onClick={() => deleteComment(c.id)}
                    >
                      Delete
                    </button>
                  </span>
                ) : (
                  <span className="comment-actions">
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setEditingId(c.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setDeletingId(c.id)}
                    >
                      Delete
                    </button>
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
        ))}
      </ul>
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="thread-footer">
        {replying ? (
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
        ) : (
          <>
            {reviewState !== "closed" && (
              <button
                type="button"
                className="btn"
                onClick={() => setReplying(true)}
              >
                Reply
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() =>
                void run(api.resolveThread(thread.id, !thread.resolved))
              }
            >
              {thread.resolved ? "Unresolve" : "Resolve"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
