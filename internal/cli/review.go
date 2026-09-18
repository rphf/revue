package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"github.com/rphf/revue/internal/server"
	"github.com/rphf/revue/internal/store"
)

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are reported as JSON by callers
	return fs
}

func waitForSignalOr(s *server.Server) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(ctx)
	case <-s.Done():
	}
}

// cmdOpen captures a diff and opens the browser on the new review
// (R1). The URL carries the one-time token; the server exchanges it
// for a cookie and redirects to a token-free URL (R23).
func (e *env) cmdOpen(args []string) int {
	fs := newFlagSet("open")
	noBrowser := fs.Bool("no-browser", false, "print the URL without launching a browser")
	reuse := fs.Bool("reuse", false, "add a round to this branch's open review with the same diff arguments instead of creating another review")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	diffArgs := fs.Args()
	if *reuse {
		if code, done := e.reuseReview(diffArgs, *noBrowser); done {
			return code
		}
	}

	var out struct {
		Review *store.Review `json:"review"`
		Round  *store.Round  `json:"round"`
		Cursor int64         `json:"cursor"`
	}
	if err := e.client.do("POST", "/api/reviews", map[string]any{"args": diffArgs, "branch": e.branch}, &out); err != nil {
		return e.fail(err)
	}
	url := e.authURL(fmt.Sprintf("/reviews/%d", out.Review.ID))
	code := e.printJSON(map[string]any{
		"review": out.Review,
		"round":  out.Round,
		"cursor": out.Cursor,
		"url":    url,
	})
	if code != ExitOK {
		return code
	}
	if !*noBrowser {
		if err := e.openURL(url); err != nil {
			_, _ = fmt.Fprintln(e.stderr, "could not open a browser:", err)
		}
	}
	return ExitOK
}

// reuseReview finds this branch's open review with the same diff
// arguments and adds a round to it. done is false when there is none,
// so cmdOpen falls through to creating a review.
func (e *env) reuseReview(diffArgs []string, noBrowser bool) (code int, done bool) {
	var list struct {
		Reviews []*store.Review `json:"reviews"`
	}
	if err := e.client.do("GET", "/api/reviews", nil, &list); err != nil {
		return e.fail(err), true
	}
	for _, r := range e.openReviewsForBranch(list.Reviews) {
		if !slices.Equal(r.SourceArgs, diffArgs) {
			continue
		}
		var rd struct {
			Round   *store.Round `json:"round"`
			Cursor  int64        `json:"cursor"`
			Deduped bool         `json:"deduped"`
			Notice  string       `json:"notice"`
		}
		if err := e.client.do("POST", fmt.Sprintf("/api/reviews/%d/rounds", r.ID), map[string]any{}, &rd); err != nil {
			return e.fail(err), true
		}
		url := e.authURL(fmt.Sprintf("/reviews/%d", r.ID))
		out := map[string]any{"review": r, "round": rd.Round, "url": url, "reused": true}
		if rd.Deduped {
			out["notice"] = rd.Notice
		} else {
			out["cursor"] = rd.Cursor
		}
		if code := e.printJSON(out); code != ExitOK {
			return code, true
		}
		if !noBrowser {
			if err := e.openURL(url); err != nil {
				_, _ = fmt.Fprintln(e.stderr, "could not open a browser:", err)
			}
		}
		return ExitOK, true
	}
	return ExitOK, false
}

// Plain text, not JSON: a host-side helper hands the output to a browser.
// Never fails for lack of a review; it falls back to the review list.
func (e *env) cmdURL(args []string) int {
	fs := newFlagSet("url")
	review := fs.Int64("review", 0, "review id (default: single open review for this branch, else the list)")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	next := "/"
	switch {
	case *review > 0:
		next = fmt.Sprintf("/reviews/%d", *review)
	default:
		var out struct {
			Reviews []*store.Review `json:"reviews"`
		}
		if err := e.client.do("GET", "/api/reviews", nil, &out); err != nil {
			return e.fail(err)
		}
		if open := e.openReviewsForBranch(out.Reviews); len(open) == 1 {
			next = fmt.Sprintf("/reviews/%d", open[0].ID)
		}
	}
	_, _ = fmt.Fprintln(e.stdout, e.authURL(next))
	return ExitOK
}

func (e *env) openReviewsForBranch(reviews []*store.Review) []*store.Review {
	var open []*store.Review
	for _, r := range reviews {
		if r.State != store.StateOpen {
			continue
		}
		if e.branch != "" && r.Branch != e.branch {
			continue
		}
		open = append(open, r)
	}
	return open
}

func (e *env) cmdReviews(args []string) int {
	fs := newFlagSet("reviews")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	var out struct {
		Reviews []*store.Review `json:"reviews"`
	}
	if err := e.client.do("GET", "/api/reviews", nil, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}

// resolveReview implements the default resolution: the single open
// review for the current branch, else an explicit --review (R10).
func (e *env) resolveReview(explicit int64) (int64, int) {
	if explicit > 0 {
		return explicit, ExitOK
	}
	var out struct {
		Reviews []*store.Review `json:"reviews"`
	}
	if err := e.client.do("GET", "/api/reviews", nil, &out); err != nil {
		return 0, e.fail(err)
	}
	open := e.openReviewsForBranch(out.Reviews)
	switch len(open) {
	case 1:
		return open[0].ID, ExitOK
	case 0:
		e.printJSON(&APIError{Code: "no_open_review", Message: fmt.Sprintf("no open review for branch %q; pass --review", e.branch)})
		return 0, ExitNoOpenReview
	default:
		ids := make([]int64, len(open))
		for i, r := range open {
			ids[i] = r.ID
		}
		e.printJSON(map[string]any{
			"error":   "ambiguous_review",
			"message": fmt.Sprintf("multiple open reviews for branch %q; pass --review", e.branch),
			"ids":     ids,
		})
		return 0, ExitValidation
	}
}

// cmdRound signals that a new round is ready for re-review (R12).
// Identical diffs are a no-op with a notice (KTD12).
func (e *env) cmdRound(args []string) int {
	fs := newFlagSet("round")
	review := fs.Int64("review", 0, "review id (default: single open review for this branch)")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	id, code := e.resolveReview(*review)
	if code != ExitOK {
		return code
	}
	var out map[string]any
	if err := e.client.do("POST", fmt.Sprintf("/api/reviews/%d/rounds", id), map[string]any{}, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}

// cmdReply posts an agent reply in a thread (R10). The agent can
// reply but never resolve (R6) — there is no resolve command.
func (e *env) cmdReply(args []string) int {
	fs := newFlagSet("reply")
	thread := fs.Int64("thread", 0, "thread id (required)")
	message := fs.String("m", "", "reply body (reads stdin when omitted)")
	fs.StringVar(message, "message", *message, "reply body")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	if *thread <= 0 {
		return e.failValidation("--thread is required")
	}
	body := *message
	if body == "" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil || len(data) == 0 {
			return e.failValidation("reply body required: pass -m or pipe stdin")
		}
		body = string(data)
	}
	var out map[string]any
	if err := e.client.do("POST", fmt.Sprintf("/api/threads/%d/comments", *thread), map[string]any{
		"role": store.RoleAgent, "body": body,
	}, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}

// cmdExport renders the review as markdown (R14); implemented with
// the export engine (U11).
func (e *env) cmdExport(args []string) int {
	fs := newFlagSet("export")
	review := fs.Int64("review", 0, "review id (default: single open review for this branch)")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	id, code := e.resolveReview(*review)
	if code != ExitOK {
		return code
	}
	req, err := e.client.newRequest("GET", fmt.Sprintf("/api/reviews/%d/export", id))
	if err != nil {
		return e.fail(err)
	}
	resp, err := e.client.HTTP.Do(req)
	if err != nil {
		return e.fail(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		apiErr := &APIError{Status: resp.StatusCode, Code: "unknown", Message: string(data)}
		unmarshalAPIError(data, apiErr)
		return e.fail(apiErr)
	}
	_, err = io.Copy(e.stdout, resp.Body)
	if err != nil {
		return ExitError
	}
	return ExitOK
}
