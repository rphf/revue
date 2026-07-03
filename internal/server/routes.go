package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/rphf/revue/internal/gitx"
	"github.com/rphf/revue/internal/server/ui"
	"github.com/rphf/revue/internal/store"
)

// Event types (KTD6). Draft mutations are deliberately absent: drafts
// never reach the event log, so no agent-facing read can see them
// before submission (R5, AE3).
const (
	eventReviewCreated = "review.created"
	eventRoundCreated  = "round.created"
	eventSubmitted     = "review.submitted"
	eventClosed        = "review.closed"
	eventReopened      = "review.reopened"
	eventReplied       = "thread.replied"
	eventResolved      = "thread.resolved"
	eventUnresolved    = "thread.unresolved"
)

// Handler builds the full middleware + route stack.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealth)

	mux.HandleFunc("POST /api/reviews", s.handleCreateReview)
	mux.HandleFunc("GET /api/reviews", s.handleListReviews)
	mux.HandleFunc("GET /api/reviews/{id}", s.handleGetReview)
	mux.HandleFunc("POST /api/reviews/{id}/rounds", s.handleCreateRound)
	mux.HandleFunc("GET /api/reviews/{id}/rounds", s.handleListRounds)
	mux.HandleFunc("GET /api/reviews/{id}/rounds/{seq}", s.handleGetRound)
	mux.HandleFunc("GET /api/reviews/{id}/rounds/{seq}/patch", s.handleGetPatch)
	mux.HandleFunc("GET /api/reviews/{id}/rounds/{seq}/file", s.handleGetFileVersions)
	mux.HandleFunc("GET /api/reviews/{id}/threads", s.handleListThreads)
	mux.HandleFunc("POST /api/reviews/{id}/threads", s.handleCreateThread)
	mux.HandleFunc("POST /api/reviews/{id}/submit", s.handleSubmit)
	mux.HandleFunc("POST /api/reviews/{id}/close", s.handleClose)
	mux.HandleFunc("POST /api/reviews/{id}/reopen", s.handleReopen)
	mux.HandleFunc("GET /api/reviews/{id}/feedback", s.handleFeedback)
	mux.HandleFunc("GET /api/reviews/{id}/events", s.handleEvents)
	mux.HandleFunc("GET /api/reviews/{id}/wait", s.handleWait)

	mux.HandleFunc("POST /api/threads/{id}/comments", s.handleReply)
	mux.HandleFunc("POST /api/threads/{id}/resolve", s.handleResolve(true))
	mux.HandleFunc("POST /api/threads/{id}/unresolve", s.handleResolve(false))
	mux.HandleFunc("PATCH /api/comments/{id}", s.handleEditComment)
	mux.HandleFunc("DELETE /api/comments/{id}", s.handleDeleteComment)

	mux.Handle("/", ui.Handler())

	return s.secure(mux)
}

// secure applies R23 to every request: same-origin, then auth (header
// token for the CLI, cookie for the browser); /auth performs the
// one-time token-for-cookie exchange.
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
	json.NewEncoder(w).Encode(v)
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

func (s *Server) reviewFromPath(w http.ResponseWriter, r *http.Request) (*store.Review, bool) {
	id := parseInt64(r.PathValue("id"))
	review, err := s.store.GetReview(id)
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusNotFound, "not_found", fmt.Sprintf("review %d not found", id))
		return nil, false
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return nil, false
	}
	return review, true
}

// stateError maps a non-open review to the KTD7-distinct error codes.
func stateError(w http.ResponseWriter, review *store.Review) {
	switch review.State {
	case store.StateApproved:
		httpError(w, http.StatusConflict, "review_approved", "review is approved and read-only until reopened")
	case store.StateClosed:
		httpError(w, http.StatusConflict, "review_closed", "review is closed")
	default:
		httpError(w, http.StatusConflict, "review_not_open", "review is not open")
	}
}

// --- health ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repoRoot": s.repoRoot})
}

// --- reviews ---

type createReviewRequest struct {
	Args   []string `json:"args"`
	Branch string   `json:"branch"`
}

func (s *Server) handleCreateReview(w http.ResponseWriter, r *http.Request) {
	var req createReviewRequest
	if !readJSON(w, r, &req) {
		return
	}
	capture, err := gitx.Capture(s.repoRoot, req.Args)
	if errors.Is(err, gitx.ErrInvalidArg) {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	if capture.Empty() {
		// KTD12: opening a review on an empty diff refuses with a notice.
		httpError(w, http.StatusUnprocessableEntity, "empty_diff", "the diff is empty; nothing to review")
		return
	}
	var review *store.Review
	var round *store.Round
	var evt *store.Event
	err = s.store.WithTx(func(tx *store.Store) error {
		var err error
		review, err = tx.CreateReview(s.repoRoot, req.Branch, req.Args)
		if err != nil {
			return err
		}
		round, err = tx.CreateRound(review.ID, capture.Patch, roundFiles(capture))
		if err != nil {
			return err
		}
		evt, err = tx.AppendEvent(review.ID, eventReviewCreated, map[string]any{"review": review, "round": round.Seq})
		return err
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.bus.notify(review.ID)
	// cursor: reads from here see only what happens after creation.
	writeJSON(w, http.StatusCreated, map[string]any{"review": review, "round": round, "cursor": evt.ID})
}

func roundFiles(c *gitx.Result) []store.NewRoundFile {
	files := make([]store.NewRoundFile, 0, len(c.Files))
	for _, f := range c.Files {
		status := map[string]string{
			gitx.StatusAdded:    store.FileAdded,
			gitx.StatusModified: store.FileModified,
			gitx.StatusDeleted:  store.FileDeleted,
			gitx.StatusRenamed:  store.FileRenamed,
		}[f.Status]
		files = append(files, store.NewRoundFile{
			Path: f.Path, OldPath: f.OldPath, Status: status, IsBinary: f.IsBinary,
			OldContent: f.OldContent, NewContent: f.NewContent,
		})
	}
	return files
}

func (s *Server) handleListReviews(w http.ResponseWriter, r *http.Request) {
	reviews, err := s.store.ListReviews(s.repoRoot)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if branch := r.URL.Query().Get("branch"); branch != "" {
		filtered := reviews[:0]
		for _, rv := range reviews {
			if rv.Branch == branch {
				filtered = append(filtered, rv)
			}
		}
		reviews = filtered
	}
	if reviews == nil {
		reviews = []*store.Review{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviews": reviews})
}

func (s *Server) handleGetReview(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	rounds, err := s.store.ListRounds(review.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	summaries := make([]map[string]any, len(rounds))
	for i, rd := range rounds {
		summaries[i] = map[string]any{"seq": rd.Seq, "createdAt": rd.CreatedAt}
	}
	subs, err := s.store.SubmissionsForReview(review.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if subs == nil {
		subs = []*store.Submission{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"review": review, "rounds": summaries, "submissions": subs,
	})
}

// --- rounds ---

func (s *Server) handleCreateRound(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	if review.State != store.StateOpen {
		stateError(w, review)
		return
	}
	capture, err := gitx.Capture(s.repoRoot, review.SourceArgs)
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	latest, err := s.store.LatestRound(review.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	// KTD12: identical diffs never produce duplicate rounds — restack
	// noise and double-signals are no-ops with a notice. An empty diff
	// IS a valid round (everything reverted).
	if capture.Patch == latest.Patch {
		writeJSON(w, http.StatusOK, map[string]any{
			"round": latest, "deduped": true,
			"notice": "diff is identical to the current round; no new round created",
		})
		return
	}
	var round *store.Round
	var evt *store.Event
	err = s.store.WithTx(func(tx *store.Store) error {
		var err error
		round, err = tx.CreateRound(review.ID, capture.Patch, roundFiles(capture))
		if err != nil {
			return err
		}
		if err := s.anchor.Recompute(tx, review.ID, latest.ID, round.ID); err != nil {
			return err
		}
		evt, err = tx.AppendEvent(review.ID, eventRoundCreated, map[string]any{"round": round})
		return err
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.bus.notify(review.ID)
	writeJSON(w, http.StatusCreated, map[string]any{"round": round, "deduped": false, "cursor": evt.ID})
}

func (s *Server) handleListRounds(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	rounds, err := s.store.ListRounds(review.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rounds": rounds})
}

func (s *Server) roundFromPath(w http.ResponseWriter, r *http.Request, review *store.Review) (*store.Round, bool) {
	seq, err := strconv.Atoi(r.PathValue("seq"))
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", "invalid round number")
		return nil, false
	}
	round, err := s.store.GetRound(review.ID, seq)
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusNotFound, "not_found", fmt.Sprintf("round %d not found", seq))
		return nil, false
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return nil, false
	}
	return round, true
}

func (s *Server) handleGetRound(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	round, ok := s.roundFromPath(w, r, review)
	if !ok {
		return
	}
	files, err := s.store.FilesForRound(round.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if files == nil {
		files = []*store.RoundFile{}
	}
	anchors, err := s.store.AnchorsForRound(round.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if anchors == nil {
		anchors = []*store.ThreadAnchor{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"round": round, "files": files, "anchors": anchors})
}

func (s *Server) handleGetPatch(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	round, ok := s.roundFromPath(w, r, review)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(round.Patch))
}

// handleGetFileVersions serves full old/new contents from the round's
// frozen snapshot — never the live tree (R25, KTD1).
func (s *Server) handleGetFileVersions(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	round, ok := s.roundFromPath(w, r, review)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		httpError(w, http.StatusBadRequest, "validation", "path query parameter required")
		return
	}
	files, err := s.store.FilesForRound(round.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	for _, f := range files {
		if f.Path != path {
			continue
		}
		resp := map[string]any{
			"path": f.Path, "oldPath": f.OldPath, "status": f.Status, "isBinary": f.IsBinary,
			"oldContent": nil, "newContent": nil,
		}
		if f.OldBlob != "" {
			content, err := s.store.Blob(f.OldBlob)
			if err != nil {
				httpError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			resp["oldContent"] = string(content)
		}
		if f.NewBlob != "" {
			content, err := s.store.Blob(f.NewBlob)
			if err != nil {
				httpError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			resp["newContent"] = string(content)
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	httpError(w, http.StatusNotFound, "not_found", fmt.Sprintf("file %q not in round %d", path, round.Seq))
}

// --- threads and comments ---

// threadView is a thread with everything a client needs to render it.
type threadView struct {
	*store.Thread
	OriginRoundSeq int                   `json:"originRoundSeq"`
	Anchors        []*store.ThreadAnchor `json:"anchors"`
	Comments       []*store.Comment      `json:"comments"`
	Quote          *quote                `json:"quote,omitempty"`
}

// quote is snapshot context for agent feedback (R10): where the thread
// points and the quoted lines from the frozen blobs.
type quote struct {
	Path      string   `json:"path"`
	Side      string   `json:"side"`
	StartLine int      `json:"startLine"`
	Line      int      `json:"line"`
	Lines     []string `json:"lines"`
	RoundSeq  int      `json:"roundSeq"`
}

func threadViews(st *store.Store, review *store.Review, includeDrafts, withQuotes bool) ([]*threadView, error) {
	threads, err := st.ThreadsForReview(review.ID, includeDrafts)
	if err != nil {
		return nil, err
	}
	roundSeq := map[int64]int{}
	rounds, err := st.ListRounds(review.ID)
	if err != nil {
		return nil, err
	}
	for _, rd := range rounds {
		roundSeq[rd.ID] = rd.Seq
	}
	views := make([]*threadView, 0, len(threads))
	for _, t := range threads {
		anchors, err := st.AnchorsForThread(t.ID)
		if err != nil {
			return nil, err
		}
		comments, err := st.CommentsForThread(t.ID, includeDrafts)
		if err != nil {
			return nil, err
		}
		v := &threadView{
			Thread: t, Anchors: anchors, Comments: comments,
			OriginRoundSeq: roundSeq[t.OriginRoundID],
		}
		if withQuotes && len(anchors) > 0 {
			// Quote from the origin-round anchor: that snapshot is what
			// the comment was written against.
			for _, a := range anchors {
				if a.RoundID == t.OriginRoundID {
					q, err := quoteFor(st, a, roundSeq[a.RoundID])
					if err == nil && q != nil {
						v.Quote = q
					}
					break
				}
			}
		}
		views = append(views, v)
	}
	return views, nil
}

// quoteFor slices the anchored line range out of the round's frozen
// blob (new side for additions, old side for deletions).
func quoteFor(st *store.Store, a *store.ThreadAnchor, roundSeq int) (*quote, error) {
	files, err := st.FilesForRound(a.RoundID)
	if err != nil {
		return nil, err
	}
	var blobHash string
	for _, f := range files {
		if f.Path != a.Path {
			continue
		}
		if a.Side == store.SideAdditions {
			blobHash = f.NewBlob
		} else {
			blobHash = f.OldBlob
		}
		break
	}
	if blobHash == "" {
		return nil, nil
	}
	content, err := st.Blob(blobHash)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(content), "\n")
	start := a.Line
	if a.StartLine != nil {
		start = *a.StartLine
	}
	if start < 1 || a.Line > len(lines) || start > a.Line {
		return nil, nil
	}
	return &quote{
		Path: a.Path, Side: a.Side, StartLine: start, Line: a.Line,
		Lines: lines[start-1 : a.Line], RoundSeq: roundSeq,
	}, nil
}

func (s *Server) handleListThreads(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	includeDrafts := r.URL.Query().Get("drafts") == "1"
	withQuotes := r.URL.Query().Get("quote") == "1"
	views, err := threadViews(s.store, review, includeDrafts, withQuotes)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": views})
}

type createThreadRequest struct {
	RoundSeq  int    `json:"roundSeq"` // 0 means latest
	Path      string `json:"path"`
	Side      string `json:"side"`
	StartLine *int   `json:"startLine,omitempty"`
	Line      int    `json:"line"`
	Body      string `json:"body"`
}

// handleCreateThread starts a reviewer draft thread (R4, R5). Drafts
// emit no events: they are invisible until submission.
func (s *Server) handleCreateThread(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	if review.State == store.StateClosed {
		stateError(w, review)
		return
	}
	var req createThreadRequest
	if !readJSON(w, r, &req) {
		return
	}
	if req.Path == "" || req.Line < 1 || req.Body == "" ||
		(req.Side != store.SideAdditions && req.Side != store.SideDeletions) {
		httpError(w, http.StatusBadRequest, "validation", "path, side (additions|deletions), line >= 1, and body are required")
		return
	}
	var round *store.Round
	var err error
	if req.RoundSeq == 0 {
		round, err = s.store.LatestRound(review.ID)
	} else {
		round, err = s.store.GetRound(review.ID, req.RoundSeq)
	}
	if err != nil {
		httpError(w, http.StatusNotFound, "not_found", "round not found")
		return
	}
	anchor := store.Anchor{Path: req.Path, Side: req.Side, StartLine: req.StartLine, Line: req.Line}
	var thread *store.Thread
	var comment *store.Comment
	err = s.store.WithTx(func(tx *store.Store) error {
		var err error
		thread, comment, err = tx.CreateThread(review.ID, round.ID, anchor, store.RoleReviewer, req.Body, true)
		return err
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"thread": thread, "comment": comment})
}

type replyRequest struct {
	Role string `json:"role"`
	Body string `json:"body"`
}

// handleReply adds a comment to a thread. Reviewer replies are drafts
// until submit; agent replies are immediate and evented (R6, R7).
// Agents are rejected on approved (AE9/R20) and closed reviews.
func (s *Server) handleReply(w http.ResponseWriter, r *http.Request) {
	threadID := parseInt64(r.PathValue("id"))
	thread, err := s.store.GetThread(threadID)
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusNotFound, "not_found", "thread not found")
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	review, err := s.store.GetReview(thread.ReviewID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
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
	if req.Role == store.RoleAgent && review.State != store.StateOpen {
		stateError(w, review)
		return
	}
	if req.Role == store.RoleReviewer && review.State == store.StateClosed {
		stateError(w, review)
		return
	}
	draft := req.Role == store.RoleReviewer
	var comment *store.Comment
	var evt *store.Event
	err = s.store.WithTx(func(tx *store.Store) error {
		var err error
		comment, err = tx.AddComment(threadID, req.Role, req.Body, draft)
		if err != nil {
			return err
		}
		if !draft {
			evt, err = tx.AppendEvent(review.ID, eventReplied, map[string]any{"thread": thread, "comment": comment})
		}
		return err
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	resp := map[string]any{"comment": comment}
	if !draft {
		s.bus.notify(review.ID)
		resp["cursor"] = evt.ID
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleResolve(resolved bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		threadID := parseInt64(r.PathValue("id"))
		thread, err := s.store.GetThread(threadID)
		if errors.Is(err, store.ErrNotFound) {
			httpError(w, http.StatusNotFound, "not_found", "thread not found")
			return
		}
		if err != nil {
			httpError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		evt := eventResolved
		if !resolved {
			evt = eventUnresolved
		}
		err = s.store.WithTx(func(tx *store.Store) error {
			if err := tx.SetThreadResolved(threadID, resolved); err != nil {
				return err
			}
			_, err := tx.AppendEvent(thread.ReviewID, evt, map[string]any{"threadId": threadID})
			return err
		})
		if err != nil {
			httpError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		s.bus.notify(thread.ReviewID)
		writeJSON(w, http.StatusOK, map[string]any{"threadId": threadID, "resolved": resolved})
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
		httpError(w, http.StatusConflict, "not_draft", "submitted comments are immutable")
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	comment, err := s.store.GetComment(id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
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
		httpError(w, http.StatusConflict, "not_draft", "submitted comments cannot be deleted")
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- submit and lifecycle ---

type submitRequest struct {
	Verdict string `json:"verdict"`
	Summary string `json:"summary"`
}

// handleSubmit publishes all reviewer drafts with a verdict in one
// transaction and one event, so the agent receives everything at once
// and nothing before (R5, AE3). Zero-comment submissions are legal.
func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	if review.State != store.StateOpen {
		stateError(w, review)
		return
	}
	var req submitRequest
	if !readJSON(w, r, &req) {
		return
	}
	if req.Verdict != store.VerdictComment && req.Verdict != store.VerdictRequestChanges && req.Verdict != store.VerdictApprove {
		httpError(w, http.StatusBadRequest, "validation", "verdict must be comment, request_changes, or approve")
		return
	}
	round, err := s.store.LatestRound(review.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	var submission *store.Submission
	err = s.store.WithTx(func(tx *store.Store) error {
		var err error
		submission, err = tx.Submit(review.ID, round.ID, req.Verdict, req.Summary)
		if err != nil {
			return err
		}
		if req.Verdict == store.VerdictApprove {
			if err := tx.SetReviewState(review.ID, store.StateApproved); err != nil {
				return err
			}
		}
		current, err := tx.GetReview(review.ID)
		if err != nil {
			return err
		}
		// The submitted event carries the full delivery: submission,
		// verdict, and every thread it published.
		threads, err := threadViews(tx, current, false, false)
		if err != nil {
			return err
		}
		_, err = tx.AppendEvent(review.ID, eventSubmitted, map[string]any{
			"submission": submission, "review": current, "threads": threads,
		})
		return err
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.bus.notify(review.ID)
	writeJSON(w, http.StatusCreated, map[string]any{"submission": submission})
}

func (s *Server) handleClose(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	err := s.store.WithTx(func(tx *store.Store) error {
		if err := tx.SetReviewState(review.ID, store.StateClosed); err != nil {
			return err
		}
		_, err := tx.AppendEvent(review.ID, eventClosed, map[string]any{"reviewId": review.ID})
		return err
	})
	if errors.Is(err, store.ErrIllegalTransition) {
		httpError(w, http.StatusConflict, "illegal_transition", err.Error())
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.bus.notify(review.ID)
	current, _ := s.store.GetReview(review.ID)
	writeJSON(w, http.StatusOK, map[string]any{"review": current})
}

func (s *Server) handleReopen(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	err := s.store.WithTx(func(tx *store.Store) error {
		if err := tx.SetReviewState(review.ID, store.StateOpen); err != nil {
			return err
		}
		_, err := tx.AppendEvent(review.ID, eventReopened, map[string]any{"reviewId": review.ID})
		return err
	})
	if errors.Is(err, store.ErrIllegalTransition) {
		httpError(w, http.StatusConflict, "illegal_transition", err.Error())
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.bus.notify(review.ID)
	current, _ := s.store.GetReview(review.ID)
	writeJSON(w, http.StatusOK, map[string]any{"review": current})
}

// --- feedback (agent read surface, R10/R13) ---

// handleFeedback is the agent's cursor read: events since the cursor
// (drafts are never in the log) plus the full visible thread state
// with quoted snapshot context and the latest verdict.
func (s *Server) handleFeedback(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	since := parseInt64(r.URL.Query().Get("since"))
	events, err := s.store.EventsSince(review.ID, since)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if events == nil {
		events = []*store.Event{}
	}
	cursor := since
	if len(events) > 0 {
		cursor = events[len(events)-1].ID
	}
	views, err := threadViews(s.store, review, false, true)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	subs, err := s.store.SubmissionsForReview(review.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	var verdict string
	var lastSubmission *store.Submission
	if len(subs) > 0 {
		lastSubmission = subs[len(subs)-1]
		verdict = lastSubmission.Verdict
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"review":         review,
		"cursor":         cursor,
		"events":         events,
		"threads":        views,
		"verdict":        verdict,
		"lastSubmission": lastSubmission,
	})
}
