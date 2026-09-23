package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/rphf/revue/internal/anchor"
	"github.com/rphf/revue/internal/gitx"
	"github.com/rphf/revue/internal/server/ui"
	"github.com/rphf/revue/internal/store"
)

// Event types. Draft mutations are deliberately absent: drafts never
// reach the event log, so no agent-facing read can see them before the
// reviewer sends. diff.changed and focus are notices on the stream
// only, never stored.
const (
	eventSent        = "sent"
	eventReplied     = "thread.replied"
	eventResolved    = "thread.resolved"
	eventUnresolved  = "thread.unresolved"
	eventDiffChanged = "diff.changed"
	eventFocus       = "focus"
)

// Handler builds the full middleware + route stack.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealth)

	mux.HandleFunc("GET /api/diff", s.handleDiff)
	mux.HandleFunc("GET /api/diff/file", s.handleDiffFile)
	mux.HandleFunc("GET /api/diff/image", s.handleDiffImage)
	mux.HandleFunc("GET /api/asset", s.handleAsset)
	mux.HandleFunc("GET /api/threads", s.handleListThreads)
	mux.HandleFunc("POST /api/threads", s.handleCreateThread)
	mux.HandleFunc("GET /api/threads/{id}/snapshot", s.handleSnapshot)
	mux.HandleFunc("POST /api/threads/{id}/comments", s.handleReply)
	mux.HandleFunc("POST /api/threads/{id}/resolve", s.handleResolve(true))
	mux.HandleFunc("POST /api/threads/{id}/unresolve", s.handleResolve(false))
	mux.HandleFunc("PATCH /api/comments/{id}", s.handleEditComment)
	mux.HandleFunc("DELETE /api/comments/{id}", s.handleDeleteComment)
	mux.HandleFunc("POST /api/send", s.handleSend)
	mux.HandleFunc("GET /api/sends", s.handleListSends)
	mux.HandleFunc("GET /api/feedback", s.handleFeedback)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("GET /api/wait", s.handleWait)
	mux.HandleFunc("POST /api/focus", s.handleFocus)
	mux.HandleFunc("POST /api/raise", s.handleRaise)
	mux.HandleFunc("GET /api/export", s.handleExport)

	mux.Handle("/", ui.Handler())

	return s.secure(mux)
}

// secure applies the localhost security model to every request:
// same-origin, then auth (header token for the CLI, cookie for the
// browser); /auth performs the one-time token-for-cookie exchange.
func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.sameOrigin(r) {
			httpError(w, http.StatusForbidden, "forbidden_origin", "cross-origin request rejected")
			return
		}
		if r.URL.Path == "/auth" {
			s.handleAuth(w, r)
			return
		}
		if !s.authorized(r) {
			httpError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid credentials")
			return
		}
		s.activity.touch()
		next.ServeHTTP(w, r)
	})
}

// --- helpers ---

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func httpError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, apiError{Error: code, Message: msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "validation", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func parseInt64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func internalError(w http.ResponseWriter, err error) {
	httpError(w, http.StatusInternalServerError, "internal", err.Error())
}

// captureFromQuery resolves the diff named by the request's `arg`
// parameters and brings it up to date. Bad arguments and refs git
// rejects are the caller's mistake, so both answer 400.
func (s *Server) captureFromQuery(w http.ResponseWriter, args []string) (*capture, bool) {
	v, err := s.views.get(args)
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return nil, false
	}
	c, err := v.load(s.repoRoot)
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return nil, false
	}
	return c, true
}

func queryArgs(r *http.Request) []string {
	args := r.URL.Query()["arg"]
	if args == nil {
		args = []string{}
	}
	return args
}

func (s *Server) threadFromPath(w http.ResponseWriter, r *http.Request) (*store.Thread, bool) {
	id := parseInt64(r.PathValue("id"))
	thread, err := s.store.GetThread(id)
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusNotFound, "not_found", fmt.Sprintf("thread %d not found", id))
		return nil, false
	}
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	return thread, true
}

// --- health ---

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "build": s.build})
}

// --- diff ---

// handleDiff serves the current diff for the requested arguments: the
// raw patch the UI parses, the file list, and where every thread sits
// in it.
func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	args := queryArgs(r)
	c, ok := s.captureFromQuery(w, args)
	if !ok {
		return
	}
	threads, err := s.store.ListThreads(true)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"args":    args,
		"branch":  c.branch,
		"repo":    s.repoName,
		"version": c.version,
		"patch":   c.result.Patch,
		"files":   c.fileViews(),
		"anchors": c.positions(threads),
	})
}

// handleDiffFile serves both full contents of one file in the current
// capture, for context expansion and the rich markdown view.
func (s *Server) handleDiffFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		httpError(w, http.StatusBadRequest, "validation", "path query parameter required")
		return
	}
	c, ok := s.captureFromQuery(w, queryArgs(r))
	if !ok {
		return
	}
	f := c.files[path]
	if f == nil {
		httpError(w, http.StatusNotFound, "not_found", fmt.Sprintf("file %q is not in this diff", path))
		return
	}
	writeJSON(w, http.StatusOK, fileVersions(f))
}

func fileVersions(f *gitx.File) map[string]any {
	resp := map[string]any{
		"path": f.Path, "oldPath": f.OldPath, "status": f.Status, "isBinary": f.IsBinary,
		"oldContent": nil, "newContent": nil,
	}
	if f.OldContent != nil {
		resp["oldContent"] = string(f.OldContent)
	}
	if f.NewContent != nil {
		resp["newContent"] = string(f.NewContent)
	}
	return resp
}

// --- threads and comments ---

// threadView is a thread with everything a client needs to render it.
type threadView struct {
	*store.Thread
	Comments []*store.Comment `json:"comments"`
	Quote    *quote           `json:"quote,omitempty"`
}

// quote is snapshot context for agent feedback: where the thread
// points and the quoted lines from the file as it was.
type quote struct {
	Path      string   `json:"path"`
	Side      string   `json:"side"`
	StartLine int      `json:"startLine"`
	Line      int      `json:"line"`
	Lines     []string `json:"lines"`
}

func threadViews(st *store.Store, includeDrafts, withQuotes, unresolvedOnly bool) ([]*threadView, error) {
	threads, err := st.ListThreads(includeDrafts)
	if err != nil {
		return nil, err
	}
	if unresolvedOnly {
		threads = slices.DeleteFunc(threads, func(t *store.Thread) bool { return t.Resolved })
	}
	return viewsOf(st, threads, includeDrafts, withQuotes)
}

// viewsOf attaches comments, and quotes when asked, to threads with one
// comments query and one blob read per distinct snapshot.
func viewsOf(st *store.Store, threads []*store.Thread, includeDrafts, withQuotes bool) ([]*threadView, error) {
	ids := make([]int64, len(threads))
	for i, t := range threads {
		ids[i] = t.ID
	}
	comments, err := st.CommentsForThreads(ids, includeDrafts)
	if err != nil {
		return nil, err
	}
	blobs := map[string][]byte{}
	views := make([]*threadView, 0, len(threads))
	for _, t := range threads {
		v := &threadView{Thread: t, Comments: comments[t.ID]}
		if withQuotes {
			q, err := quoteFor(st, t, blobs)
			if err == nil && q != nil {
				v.Quote = q
			}
		}
		views = append(views, v)
	}
	return views, nil
}

// quoteFor slices the anchored line range out of the thread's snapshot
// (new side for additions, old side for deletions). blobs caches
// snapshot contents by hash across calls.
func quoteFor(st *store.Store, t *store.Thread, blobs map[string][]byte) (*quote, error) {
	hash := t.NewBlob
	if t.Side == store.SideDeletions {
		hash = t.OldBlob
	}
	if hash == "" {
		return nil, nil
	}
	content, ok := blobs[hash]
	if !ok {
		var err error
		if content, err = st.Blob(hash); err != nil {
			return nil, err
		}
		blobs[hash] = content
	}
	lines := strings.Split(string(content), "\n")
	start := t.Line
	if t.StartLine != nil {
		start = *t.StartLine
	}
	if start < 1 || t.Line > len(lines) || start > t.Line {
		return nil, nil
	}
	return &quote{Path: t.Path, Side: t.Side, StartLine: start, Line: t.Line, Lines: lines[start-1 : t.Line]}, nil
}

func (s *Server) handleListThreads(w http.ResponseWriter, r *http.Request) {
	includeDrafts := r.URL.Query().Get("drafts") == "1"
	withQuotes := r.URL.Query().Get("quote") == "1"
	views, err := threadViews(s.store, includeDrafts, withQuotes, false)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": views})
}

type createThreadRequest struct {
	Args      []string `json:"args"`
	Path      string   `json:"path"`
	Side      string   `json:"side"`
	StartLine *int     `json:"startLine,omitempty"`
	Line      int      `json:"line"`
	Body      string   `json:"body"`
}

// handleCreateThread starts a reviewer draft thread anchored in the
// capture the reviewer is looking at, freezing that file's contents as
// the thread's snapshot. Line 0 comments on the file as a whole, on the
// side the file exists on. Drafts emit no events: they are invisible
// until sent.
func (s *Server) handleCreateThread(w http.ResponseWriter, r *http.Request) {
	var req createThreadRequest
	if !readJSON(w, r, &req) {
		return
	}
	if req.Path == "" || req.Line < 0 || req.Body == "" ||
		(req.Side != store.SideAdditions && req.Side != store.SideDeletions) ||
		(req.Line == 0 && req.StartLine != nil) {
		httpError(w, http.StatusBadRequest, "validation", "path, side (additions|deletions), line (0 for the whole file, no range), and body are required")
		return
	}
	c, ok := s.captureFromQuery(w, req.Args)
	if !ok {
		return
	}
	f := c.files[req.Path]
	if f == nil {
		httpError(w, http.StatusConflict, "stale_diff", fmt.Sprintf("%s is not in this diff any more; the page will refresh", req.Path))
		return
	}
	side := req.Side
	if req.Line == 0 {
		side = store.SideAdditions
		if f.Status == gitx.StatusDeleted {
			side = store.SideDeletions
		}
	} else if f.IsBinary {
		httpError(w, http.StatusBadRequest, "validation", "binary files take no line comments")
		return
	}
	nt := store.NewThread{
		Path: f.Path, OldPath: f.OldPath, Status: f.Status, Side: side,
		StartLine: req.StartLine, Line: req.Line,
		OldContent: f.OldContent, NewContent: f.NewContent,
	}
	if h := anchor.Find(c.hunks, req.Path, side, req.Line); req.Line > 0 && h != nil {
		nt.HunkHash, nt.HunkStart = h.Hash, h.Start(req.Side)
	}
	var thread *store.Thread
	var comment *store.Comment
	err := s.store.WithTx(func(tx *store.Store) error {
		var err error
		thread, comment, err = tx.CreateThread(nt, store.RoleReviewer, req.Body, true)
		return err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"thread": thread, "comment": comment})
}

// handleSnapshot serves the file as it was when the thread started, so
// an outdated thread can be read against the code it was written on.
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	t, ok := s.threadFromPath(w, r)
	if !ok {
		return
	}
	resp := map[string]any{
		"path": t.Path, "oldPath": t.OldPath, "status": t.Status,
		"oldContent": nil, "newContent": nil, "createdAt": t.CreatedAt,
	}
	for _, side := range []struct{ hash, key string }{{t.OldBlob, "oldContent"}, {t.NewBlob, "newContent"}} {
		if side.hash == "" {
			continue
		}
		content, err := s.store.Blob(side.hash)
		if err != nil {
			internalError(w, err)
			return
		}
		resp[side.key] = string(content)
	}
	writeJSON(w, http.StatusOK, resp)
}

type replyRequest struct {
	Role string `json:"role"`
	Body string `json:"body"`
}

// handleReply adds a comment to a thread. Reviewer replies are drafts
// until sent; agent replies are immediate and evented.
func (s *Server) handleReply(w http.ResponseWriter, r *http.Request) {
	thread, ok := s.threadFromPath(w, r)
	if !ok {
		return
	}
	var req replyRequest
	if !readJSON(w, r, &req) {
		return
	}
	if req.Body == "" || (req.Role != store.RoleReviewer && req.Role != store.RoleAgent) {
		httpError(w, http.StatusBadRequest, "validation", "role (reviewer|agent) and body are required")
		return
	}
	draft := req.Role == store.RoleReviewer
	var comment *store.Comment
	var evt *store.Event
	err := s.store.WithTx(func(tx *store.Store) error {
		var err error
		comment, err = tx.AddComment(thread.ID, req.Role, req.Body, draft)
		if err != nil {
			return err
		}
		if !draft {
			evt, err = tx.AppendEvent(eventReplied, map[string]any{"thread": thread, "comment": comment})
		}
		return err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	resp := map[string]any{"comment": comment}
	if !draft {
		s.bus.notify()
		resp["cursor"] = evt.ID
	}
	writeJSON(w, http.StatusCreated, resp)
}

// handleResolve flips a thread's resolution. Only the reviewer's UI
// calls it; the CLI has no resolve command.
func (s *Server) handleResolve(resolved bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		thread, ok := s.threadFromPath(w, r)
		if !ok {
			return
		}
		evt := eventResolved
		if !resolved {
			evt = eventUnresolved
		}
		err := s.store.WithTx(func(tx *store.Store) error {
			if err := tx.SetThreadResolved(thread.ID, resolved); err != nil {
				return err
			}
			_, err := tx.AppendEvent(evt, map[string]any{"threadId": thread.ID})
			return err
		})
		if err != nil {
			internalError(w, err)
			return
		}
		s.bus.notify()
		writeJSON(w, http.StatusOK, map[string]any{"threadId": thread.ID, "resolved": resolved})
	}
}

type editCommentRequest struct {
	Body string `json:"body"`
}

func (s *Server) handleEditComment(w http.ResponseWriter, r *http.Request) {
	id := parseInt64(r.PathValue("id"))
	var req editCommentRequest
	if !readJSON(w, r, &req) {
		return
	}
	if req.Body == "" {
		httpError(w, http.StatusBadRequest, "validation", "body is required")
		return
	}
	err := s.store.UpdateDraftComment(id, req.Body)
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusNotFound, "not_found", "comment not found")
		return
	}
	if errors.Is(err, store.ErrNotDraft) {
		httpError(w, http.StatusConflict, "not_draft", "sent comments are immutable")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	comment, err := s.store.GetComment(id)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comment": comment})
}

func (s *Server) handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	id := parseInt64(r.PathValue("id"))
	err := s.store.WithTx(func(tx *store.Store) error {
		return tx.DeleteDraftComment(id)
	})
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusNotFound, "not_found", "comment not found")
		return
	}
	if errors.Is(err, store.ErrNotDraft) {
		httpError(w, http.StatusConflict, "not_draft", "sent comments cannot be deleted")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- send and feedback ---

type sendRequest struct {
	Note string `json:"note"`
}

// handleSend publishes every reviewer draft with a note in one
// transaction and one event, so the agent receives everything at once
// and nothing before. A note with zero drafts is legal; nothing at all
// is not.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if !readJSON(w, r, &req) {
		return
	}
	var send *store.Send
	published := []*threadView{}
	err := s.store.WithTx(func(tx *store.Store) error {
		var err error
		send, err = tx.Send(req.Note)
		if err != nil {
			return err
		}
		threads, err := tx.ThreadsInSend(send.ID)
		if err != nil {
			return err
		}
		if published, err = viewsOf(tx, threads, false, false); err != nil {
			return err
		}
		_, err = tx.AppendEvent(eventSent, map[string]any{"send": send, "threads": published})
		return err
	})
	if errors.Is(err, store.ErrNothingToSend) {
		httpError(w, http.StatusBadRequest, "validation", "nothing to send: no draft comments and no note")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	s.bus.notify()
	writeJSON(w, http.StatusCreated, map[string]any{"send": send, "threads": published})
}

// handleListSends lists every send, oldest first, so the reviewer's
// UI can group threads by the round they were last active in.
func (s *Server) handleListSends(w http.ResponseWriter, r *http.Request) {
	sends, err := s.store.ListSends()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sends": sends})
}

// handleFeedback is the agent's cursor read: events since the cursor
// (drafts are never in the log), every unresolved thread with its sent
// comments and quoted snapshot, and the most recent send with its note.
func (s *Server) handleFeedback(w http.ResponseWriter, r *http.Request) {
	since := parseInt64(r.URL.Query().Get("since"))
	events, err := s.store.EventsSince(since)
	if err != nil {
		internalError(w, err)
		return
	}
	if events == nil {
		events = []*store.Event{}
	}
	cursor := since
	if len(events) > 0 {
		cursor = events[len(events)-1].ID
	}
	views, err := threadViews(s.store, false, true, true)
	if err != nil {
		internalError(w, err)
		return
	}
	last, err := s.store.LastSend()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cursor":   cursor,
		"events":   events,
		"threads":  views,
		"lastSend": last,
	})
}
