package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rphf/revue/internal/store"
)

// --- fixtures ---

func initRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q", "-b", "main")
	mustGit(t, dir, "config", "user.email", "test@test")
	mustGit(t, dir, "config", "user.name", "test")
	writeFile(t, dir, "a.txt", "line one\nline two\nline three\nline four\n")
	mustGit(t, dir, "add", "-A")
	mustGit(t, dir, "commit", "-q", "-m", "c1")
	return dir
}

func mustGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeFile(t *testing.T, dir, path, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

type testServer struct {
	*Server
	repo    string
	dataDir string
	client  *http.Client
}

func startServer(t *testing.T, repo string, idle time.Duration) *testServer {
	t.Helper()
	dataDir := t.TempDir()
	s, err := Start(Config{RepoRoot: repo, DataDir: dataDir, IdleTimeout: idle})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.Shutdown(ctx)
	})
	return &testServer{Server: s, repo: repo, dataDir: dataDir, client: &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// do sends an authenticated JSON request.
func (ts *testServer) do(t *testing.T, method, path string, body any, out any) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, ts.URL()+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+ts.Token())
	resp, err := ts.client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if out != nil {
		defer func() { _ = resp.Body.Close() }()
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("%s %s: decode: %v", method, path, err)
		}
	}
	return resp
}

func (ts *testServer) mustStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	if resp.StatusCode != want {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d: %s", resp.StatusCode, want, body)
	}
}

type reviewResponse struct {
	Review *store.Review `json:"review"`
	Round  *store.Round  `json:"round"`
}

// openReview modifies the worktree and opens a working-tree review.
func (ts *testServer) openReview(t *testing.T) *reviewResponse {
	t.Helper()
	writeFile(t, ts.repo, "a.txt", "line one\nline two CHANGED\nline three\nline four\n")
	var out reviewResponse
	resp := ts.do(t, "POST", "/api/reviews", map[string]any{"args": []string{}, "branch": "main"}, &out)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create review status = %d", resp.StatusCode)
	}
	return &out
}

func (ts *testServer) draftThread(t *testing.T, reviewID int64, line int, body string) map[string]json.RawMessage {
	t.Helper()
	var out map[string]json.RawMessage
	resp := ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/threads", reviewID), map[string]any{
		"path": "a.txt", "side": "additions", "line": line, "body": body,
	}, &out)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("draft thread status = %d", resp.StatusCode)
	}
	return out
}

type feedback struct {
	Review  *store.Review `json:"review"`
	Cursor  int64         `json:"cursor"`
	Events  []*store.Event
	Threads []*threadView `json:"threads"`
	Verdict string        `json:"verdict"`
}

func (ts *testServer) feedback(t *testing.T, reviewID, since int64) *feedback {
	t.Helper()
	var fb feedback
	ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/feedback?since=%d", reviewID, since), nil, &fb)
	return &fb
}

// --- security (R23) ---

func TestRequestWithoutTokenRejected(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	resp, err := http.Get(ts.URL() + "/api/reviews")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no-token status = %d, want 401", resp.StatusCode)
	}
	// The SPA shell is protected too: every request authenticates.
	resp2, err := http.Get(ts.URL() + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Errorf("SPA no-token status = %d, want 401", resp2.StatusCode)
	}
}

func TestCrossOriginMutationRejected(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	req, _ := http.NewRequest("POST", ts.URL()+"/api/reviews", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+ts.Token())
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin status = %d, want 403", resp.StatusCode)
	}

	// Same-origin passes.
	ts.openReview(t)
	req2, _ := http.NewRequest("GET", ts.URL()+"/api/reviews", nil)
	req2.Header.Set("Authorization", "Bearer "+ts.Token())
	req2.Header.Set("Origin", ts.URL())
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("same-origin status = %d, want 200", resp2.StatusCode)
	}
}

func TestTokenExchangeSetsCookieAndRedirectsTokenFree(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Get(ts.URL() + "/auth?token=" + ts.Token() + "&next=/reviews/1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("auth status = %d, want 303", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/reviews/1" {
		t.Errorf("redirect location = %q, want token-free /reviews/1", loc)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == authCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no auth cookie set")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie not HttpOnly+SameSite=Strict: %+v", cookie)
	}

	// The cookie authenticates follow-up requests.
	req, _ := http.NewRequest("GET", ts.URL()+"/api/reviews", nil)
	req.AddCookie(cookie)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("cookie-authed status = %d, want 200", resp2.StatusCode)
	}

	// Bad token refused; scheme-relative next neutralized.
	resp3, err := client.Get(ts.URL() + "/auth?token=wrong")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp3.Body.Close() }()
	if resp3.StatusCode != http.StatusUnauthorized {
		t.Errorf("bad token status = %d, want 401", resp3.StatusCode)
	}
	resp4, err := client.Get(ts.URL() + "/auth?token=" + ts.Token() + "&next=//evil.example/x")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp4.Body.Close() }()
	if loc := resp4.Header.Get("Location"); loc != "/" {
		t.Errorf("open redirect not neutralized: %q", loc)
	}
}

// --- reviews and rounds ---

func TestCreateReviewRefusesEmptyDiff(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	var out apiError
	resp := ts.do(t, "POST", "/api/reviews", map[string]any{"args": []string{}}, &out)
	if resp.StatusCode != http.StatusUnprocessableEntity || out.Error != "empty_diff" {
		t.Errorf("empty diff: status=%d error=%s", resp.StatusCode, out.Error)
	}
}

func TestCreateReviewRejectsFlagArgs(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	var out apiError
	resp := ts.do(t, "POST", "/api/reviews", map[string]any{"args": []string{"--ext-diff"}}, &out)
	if resp.StatusCode != http.StatusBadRequest || out.Error != "validation" {
		t.Errorf("flag arg: status=%d error=%s", resp.StatusCode, out.Error)
	}
}

func TestReviewRoundPatchAndFileEndpoints(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)

	var list struct {
		Reviews []*store.Review `json:"reviews"`
	}
	ts.do(t, "GET", "/api/reviews", nil, &list)
	if len(list.Reviews) != 1 {
		t.Fatalf("reviews = %d, want 1", len(list.Reviews))
	}

	resp := ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/rounds/1/patch", rv.Review.ID), nil, nil)
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), "+line two CHANGED") {
		t.Errorf("patch endpoint content:\n%s", body)
	}

	var fv struct {
		OldContent *string `json:"oldContent"`
		NewContent *string `json:"newContent"`
	}
	ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/rounds/1/file?path=a.txt", rv.Review.ID), nil, &fv)
	if fv.OldContent == nil || !strings.Contains(*fv.OldContent, "line two\n") {
		t.Errorf("old content = %v", fv.OldContent)
	}
	if fv.NewContent == nil || !strings.Contains(*fv.NewContent, "line two CHANGED") {
		t.Errorf("new content = %v", fv.NewContent)
	}
}

func TestIdenticalDiffRoundCreateIsNoOpWithNotice(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)

	var out struct {
		Deduped bool         `json:"deduped"`
		Notice  string       `json:"notice"`
		Round   *store.Round `json:"round"`
	}
	resp := ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/rounds", rv.Review.ID), map[string]any{}, &out)
	if resp.StatusCode != http.StatusOK || !out.Deduped || out.Notice == "" {
		t.Errorf("dedupe: status=%d deduped=%v notice=%q", resp.StatusCode, out.Deduped, out.Notice)
	}
	if out.Round.Seq != 1 {
		t.Errorf("deduped round seq = %d, want 1", out.Round.Seq)
	}

	// A real change produces round 2 with anchors carried forward by
	// the Phase-1 stub.
	ts.draftThread(t, rv.Review.ID, 2, "note")
	writeFile(t, ts.repo, "a.txt", "line one\nline two CHANGED AGAIN\nline three\nline four\n")
	resp2 := ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/rounds", rv.Review.ID), map[string]any{}, &out)
	if resp2.StatusCode != http.StatusCreated || out.Deduped || out.Round.Seq != 2 {
		t.Errorf("round 2: status=%d deduped=%v seq=%d", resp2.StatusCode, out.Deduped, out.Round.Seq)
	}
	var round struct {
		Anchors []*store.ThreadAnchor `json:"anchors"`
	}
	ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/rounds/2", rv.Review.ID), nil, &round)
	if len(round.Anchors) != 1 {
		t.Errorf("carried anchors = %d, want 1", len(round.Anchors))
	}
}

// --- AE3: draft isolation and atomic delivery ---

func TestAE3SubmitDeliversDraftsAndVerdictAtomically(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)

	ts.draftThread(t, rv.Review.ID, 2, "first draft")
	ts.draftThread(t, rv.Review.ID, 3, "second draft")

	// Before submission the agent surface shows nothing: no threads in
	// feedback, no draft events in the log.
	fb := ts.feedback(t, rv.Review.ID, 0)
	if len(fb.Threads) != 0 {
		t.Fatalf("drafts visible before submit: %d threads", len(fb.Threads))
	}
	for _, e := range fb.Events {
		if strings.Contains(e.Type, "thread") || strings.Contains(e.Type, "comment") {
			t.Fatalf("draft leaked into event log: %s", e.Type)
		}
	}
	cursorBefore := fb.Cursor

	var sub struct {
		Submission *store.Submission `json:"submission"`
	}
	resp := ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{
		"verdict": "request_changes", "summary": "please fix both",
	}, &sub)
	ts.mustStatus(t, resp, http.StatusCreated)

	// After: exactly one new event carrying submission, verdict, and
	// both threads at once.
	fb = ts.feedback(t, rv.Review.ID, cursorBefore)
	if len(fb.Events) != 1 || fb.Events[0].Type != eventSubmitted {
		t.Fatalf("expected exactly one submitted event, got %+v", fb.Events)
	}
	var payload struct {
		Submission *store.Submission `json:"submission"`
		Threads    []*threadView     `json:"threads"`
	}
	if err := json.Unmarshal(fb.Events[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Submission.Verdict != "request_changes" || len(payload.Threads) != 2 {
		t.Errorf("event payload: verdict=%s threads=%d", payload.Submission.Verdict, len(payload.Threads))
	}
	if fb.Verdict != "request_changes" || len(fb.Threads) != 2 {
		t.Errorf("feedback after submit: verdict=%s threads=%d", fb.Verdict, len(fb.Threads))
	}
	// Quoted snapshot context present (R10).
	if fb.Threads[0].Quote == nil || len(fb.Threads[0].Quote.Lines) == 0 {
		t.Errorf("missing quote: %+v", fb.Threads[0])
	} else if fb.Threads[0].Quote.Lines[0] != "line two CHANGED" {
		t.Errorf("quote lines = %v", fb.Threads[0].Quote.Lines)
	}
}

func TestSubmitWithZeroCommentsIsLegal(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)
	var sub struct {
		Submission *store.Submission `json:"submission"`
	}
	resp := ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{
		"verdict": "comment", "summary": "looks fine overall",
	}, &sub)
	ts.mustStatus(t, resp, http.StatusCreated)
	if sub.Submission.Verdict != "comment" {
		t.Errorf("verdict = %s", sub.Submission.Verdict)
	}
}

// --- AE6: no submission lost between waits (server half) ---

func TestAE6SinceReplayReturnsExactlyMissedEvents(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)

	fb := ts.feedback(t, rv.Review.ID, 0)
	cursor := fb.Cursor

	// Submission lands while no wait is active.
	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{"verdict": "comment"}, nil)

	// A later wait picks it up immediately from the cursor.
	var wo waitOutcome
	resp := ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/wait?since=%d&timeout=5s", rv.Review.ID, cursor), nil, &wo)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("wait status = %d", resp.StatusCode)
	}
	if wo.Outcome != "submitted" || wo.Submission == nil {
		t.Fatalf("wait outcome = %+v, want submitted", wo)
	}

	// And the replay returns exactly the one missed event.
	fb = ts.feedback(t, rv.Review.ID, cursor)
	if len(fb.Events) != 1 || fb.Events[0].Type != eventSubmitted {
		t.Errorf("replay = %+v, want exactly the submitted event", fb.Events)
	}
	// Nothing beyond the new cursor.
	fb = ts.feedback(t, rv.Review.ID, fb.Cursor)
	if len(fb.Events) != 0 {
		t.Errorf("replay past cursor returned %d events", len(fb.Events))
	}
}

func TestWaitUnblocksOnSubmit(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)
	fb := ts.feedback(t, rv.Review.ID, 0)

	done := make(chan waitOutcome, 1)
	go func() {
		var wo waitOutcome
		ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/wait?since=%d&timeout=30s", rv.Review.ID, fb.Cursor), nil, &wo)
		done <- wo
	}()
	time.Sleep(100 * time.Millisecond) // let the long-poll park

	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{"verdict": "approve"}, nil)

	select {
	case wo := <-done:
		if wo.Outcome != "submitted" || wo.Review.State != store.StateApproved {
			t.Errorf("outcome = %+v", wo)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("wait did not unblock on submit")
	}
}

func TestWaitTimesOutDistinctly(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)
	fb := ts.feedback(t, rv.Review.ID, 0)
	var wo waitOutcome
	ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/wait?since=%d&timeout=100ms", rv.Review.ID, fb.Cursor), nil, &wo)
	if wo.Outcome != "timeout" {
		t.Errorf("outcome = %s, want timeout", wo.Outcome)
	}
}

// --- AE8: close unblocks the waiter with a distinct outcome ---

func TestAE8CloseEmitsDistinctEventAndUnblocksWaiter(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)
	fb := ts.feedback(t, rv.Review.ID, 0)

	done := make(chan waitOutcome, 1)
	go func() {
		var wo waitOutcome
		ts.do(t, "GET", fmt.Sprintf("/api/reviews/%d/wait?since=%d&timeout=30s", rv.Review.ID, fb.Cursor), nil, &wo)
		done <- wo
	}()
	time.Sleep(100 * time.Millisecond)

	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/close", rv.Review.ID), map[string]any{}, nil)

	select {
	case wo := <-done:
		if wo.Outcome != "closed" {
			t.Errorf("outcome = %s, want closed (distinct from submission)", wo.Outcome)
		}
		if wo.Review.State != store.StateClosed {
			t.Errorf("review state = %s", wo.Review.State)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("wait did not unblock on close")
	}

	// The event log carries the distinct close event.
	fb = ts.feedback(t, rv.Review.ID, fb.Cursor)
	found := false
	for _, e := range fb.Events {
		if e.Type == eventClosed {
			found = true
		}
	}
	if !found {
		t.Error("no review.closed event in log")
	}
}

// --- AE9: approved means read-only for the agent ---

func TestAE9ReplyToApprovedReviewRejected(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)
	ts.draftThread(t, rv.Review.ID, 2, "nit")
	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{"verdict": "approve"}, nil)

	fb := ts.feedback(t, rv.Review.ID, 0)
	if len(fb.Threads) != 1 {
		t.Fatalf("threads = %d", len(fb.Threads))
	}
	threadID := fb.Threads[0].ID
	commentsBefore := len(fb.Threads[0].Comments)

	var out apiError
	resp := ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", threadID), map[string]any{
		"role": "agent", "body": "but actually...",
	}, &out)
	if resp.StatusCode != http.StatusConflict || out.Error != "review_approved" {
		t.Errorf("agent reply on approved: status=%d error=%s, want 409 review_approved", resp.StatusCode, out.Error)
	}

	// Review unchanged.
	fb = ts.feedback(t, rv.Review.ID, 0)
	if len(fb.Threads[0].Comments) != commentsBefore {
		t.Error("rejected reply mutated the review")
	}

	// Reopen restores the agent's ability to reply (R20).
	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/reopen", rv.Review.ID), map[string]any{}, nil)
	resp2 := ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", threadID), map[string]any{
		"role": "agent", "body": "fixed in latest round",
	}, nil)
	ts.mustStatus(t, resp2, http.StatusCreated)
}

// --- AE4 server half: agent reply is evented, resolution stays with reviewer ---

func TestAE4AgentReplyEventedAndOnlyReviewerResolves(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)
	ts.draftThread(t, rv.Review.ID, 2, "why this?")
	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{"verdict": "comment"}, nil)

	fb := ts.feedback(t, rv.Review.ID, 0)
	threadID := fb.Threads[0].ID
	cursor := fb.Cursor

	resp := ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", threadID), map[string]any{
		"role": "agent", "body": "because of X",
	}, nil)
	ts.mustStatus(t, resp, http.StatusCreated)

	fb = ts.feedback(t, rv.Review.ID, cursor)
	if len(fb.Events) != 1 || fb.Events[0].Type != eventReplied {
		t.Fatalf("expected thread.replied event, got %+v", fb.Events)
	}
	// The agent's reply does not resolve the thread.
	if fb.Threads[0].Resolved {
		t.Error("agent reply resolved the thread")
	}
	// The reviewer resolves it.
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/resolve", threadID), map[string]any{}, nil)
	fb = ts.feedback(t, rv.Review.ID, 0)
	if !fb.Threads[0].Resolved {
		t.Error("resolve did not stick")
	}
}

// --- SSE ---

func TestSSEStreamsReplayAndLive(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	rv := ts.openReview(t)

	req, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/reviews/%d/events?since=0", ts.URL(), rv.Review.ID), nil)
	req.Header.Set("Authorization", "Bearer "+ts.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %s", ct)
	}

	types := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var evt store.Event
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &evt); err == nil {
				types <- evt.Type
			}
		}
	}()

	// Replay: review.created arrives first.
	select {
	case typ := <-types:
		if typ != eventReviewCreated {
			t.Fatalf("first replayed event = %s", typ)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no replay event")
	}

	// Live: a submission arrives without reconnecting.
	ts.do(t, "POST", fmt.Sprintf("/api/reviews/%d/submit", rv.Review.ID), map[string]any{"verdict": "comment"}, nil)
	select {
	case typ := <-types:
		if typ != eventSubmitted {
			t.Fatalf("live event = %s", typ)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no live event")
	}
}

// --- lifecycle (KTD5) ---

func TestKillAndReviveRebindsRecordedPortAndToken(t *testing.T) {
	repo := initRepo(t)
	dataDir := t.TempDir()
	s1, err := Start(Config{RepoRoot: repo, DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	url1, token1 := s1.URL(), s1.Token()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = s1.Shutdown(ctx)
	cancel()

	s2, err := Start(Config{RepoRoot: repo, DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s2.Shutdown(ctx)
		cancel()
	}()
	if s2.URL() != url1 {
		t.Errorf("revived URL = %s, want %s (port rebind)", s2.URL(), url1)
	}
	if s2.Token() != token1 {
		t.Errorf("revived token differs; open-tab cookies would break")
	}

	st, err := ReadState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if !Healthy(st) {
		t.Error("state file does not point at a healthy server")
	}
	info, err := os.Stat(filepath.Join(dataDir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("state file mode = %o, want 0600 (token is a credential)", info.Mode().Perm())
	}
}

func TestIdleShutdownFiresWhenQuiet(t *testing.T) {
	ts := startServer(t, initRepo(t), 150*time.Millisecond)
	select {
	case <-ts.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("idle shutdown did not fire")
	}
}

func TestIdleShutdownBlockedByOpenStreams(t *testing.T) {
	for _, kind := range []string{"sse", "wait"} {
		t.Run(kind, func(t *testing.T) {
			ts := startServer(t, initRepo(t), 150*time.Millisecond)
			rv := ts.openReview(t)

			var path string
			if kind == "sse" {
				path = fmt.Sprintf("/api/reviews/%d/events", rv.Review.ID)
			} else {
				path = fmt.Sprintf("/api/reviews/%d/wait?timeout=10s", rv.Review.ID)
			}
			// Drive the request from a goroutine: a wait long-poll
			// sends no headers until it resolves, so Do() blocks.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL()+path, nil)
			req.Header.Set("Authorization", "Bearer "+ts.Token())
			go func() {
				resp, err := http.DefaultClient.Do(req)
				if err == nil {
					_, _ = io.Copy(io.Discard, resp.Body)
					_ = resp.Body.Close()
				}
			}()

			// Well past the idle timeout, the server must still be up.
			select {
			case <-ts.Done():
				t.Fatal("idle shutdown fired while a stream was open")
			case <-time.After(600 * time.Millisecond):
			}
			cancel() // drop the stream

			select {
			case <-ts.Done():
			case <-time.After(3 * time.Second):
				t.Fatal("idle shutdown did not fire after stream closed")
			}
		})
	}
}

func TestXDGDirectorySplit(t *testing.T) {
	t.Setenv("REVUE_DATA_DIR", "")
	t.Setenv("XDG_DATA_HOME", "/tmp/xdg-data")
	t.Setenv("XDG_STATE_HOME", "/tmp/xdg-state")

	dataDir, err := DataDir("/some/repo")
	if err != nil {
		t.Fatal(err)
	}
	stateDir, err := StateDir("/some/repo")
	if err != nil {
		t.Fatal(err)
	}
	key := repoKey("/some/repo")
	if dataDir != filepath.Join("/tmp/xdg-data", "revue", key) {
		t.Errorf("dataDir = %s, want under XDG_DATA_HOME", dataDir)
	}
	if stateDir != filepath.Join("/tmp/xdg-state", "revue", key) {
		t.Errorf("stateDir = %s, want under XDG_STATE_HOME", stateDir)
	}

	// Defaults follow the nvim-style convention.
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("XDG_STATE_HOME", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dataDir, _ = DataDir("/some/repo")
	stateDir, _ = StateDir("/some/repo")
	if dataDir != filepath.Join(home, ".local", "share", "revue", key) {
		t.Errorf("default dataDir = %s, want ~/.local/share/revue/...", dataDir)
	}
	if stateDir != filepath.Join(home, ".local", "state", "revue", key) {
		t.Errorf("default stateDir = %s, want ~/.local/state/revue/...", stateDir)
	}

	// A single REVUE_DATA_DIR root overrides both (tests, smoke, e2e).
	t.Setenv("REVUE_DATA_DIR", "/tmp/one-root")
	dataDir, _ = DataDir("/some/repo")
	stateDir, _ = StateDir("/some/repo")
	if dataDir != stateDir || dataDir != filepath.Join("/tmp/one-root", key) {
		t.Errorf("REVUE_DATA_DIR override: data=%s state=%s", dataDir, stateDir)
	}
}

func TestPublicURLAllowsItsOriginAndIsRecorded(t *testing.T) {
	repo := initRepo(t)
	dataDir := t.TempDir()
	s, err := Start(Config{RepoRoot: repo, DataDir: dataDir, PublicURL: "http://agent1.localhost:3191/"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.Shutdown(ctx)
		cancel()
	}()
	if s.PublicURL() != "http://agent1.localhost:3191" {
		t.Errorf("PublicURL = %q, want trailing slash stripped", s.PublicURL())
	}
	if !strings.HasPrefix(s.URL(), "http://127.0.0.1:") {
		t.Errorf("URL = %q, want the loopback dial address", s.URL())
	}

	for origin, want := range map[string]int{
		"http://agent1.localhost:3191": http.StatusOK,
		"http://agent2.localhost:3191": http.StatusForbidden,
		"http://agent1.localhost":      http.StatusForbidden,
	} {
		req, _ := http.NewRequest("GET", s.URL()+"/api/reviews", nil)
		req.Header.Set("Authorization", "Bearer "+s.Token())
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("origin %s: status %d, want %d", origin, resp.StatusCode, want)
		}
	}

	st, err := ReadState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if st.PublicURL != "http://agent1.localhost:3191" {
		t.Errorf("state publicUrl = %q", st.PublicURL)
	}
	if got := st.AuthURL("/reviews/1"); got != "http://agent1.localhost:3191/auth?token="+s.Token()+"&next=%2Freviews%2F1" {
		t.Errorf("AuthURL = %q", got)
	}
	if st.BaseURL() != s.URL() {
		t.Errorf("state BaseURL = %q, server URL = %q", st.BaseURL(), s.URL())
	}
}

func TestFixedPortIsHonouredAndConflictIsAnError(t *testing.T) {
	repo := initRepo(t)
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	s, err := Start(Config{RepoRoot: repo, DataDir: t.TempDir(), Bind: "127.0.0.1", Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.Shutdown(ctx)
		cancel()
	}()
	if want := fmt.Sprintf("http://127.0.0.1:%d", port); s.URL() != want {
		t.Errorf("URL = %q, want %q", s.URL(), want)
	}

	if _, err := Start(Config{RepoRoot: repo, DataDir: t.TempDir(), Port: port}); err == nil {
		t.Error("second Start on the same fixed port succeeded, want error")
	}
}

func TestLoopbackHostAndPublicURLNormalization(t *testing.T) {
	for bind, want := range map[string]string{
		"": "127.0.0.1", "0.0.0.0": "127.0.0.1", "::": "127.0.0.1", "[::]": "127.0.0.1",
		"127.0.0.1": "127.0.0.1", "10.0.0.5": "10.0.0.5",
	} {
		if got := loopbackHost(bind); got != want {
			t.Errorf("loopbackHost(%q) = %q, want %q", bind, got, want)
		}
	}
	for raw, want := range map[string]string{
		"":                              "",
		"http://agent1.localhost:3191":  "http://agent1.localhost:3191",
		"http://agent1.localhost:3191/": "http://agent1.localhost:3191",
		"https://box.example/revue/":    "https://box.example/revue",
	} {
		got, err := normalizePublicURL(raw)
		if err != nil || got != want {
			t.Errorf("normalizePublicURL(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"agent1.localhost:3191", "ftp://x", "http://x/?q=1", "http://x/#f", "http://"} {
		if _, err := normalizePublicURL(raw); err == nil {
			t.Errorf("normalizePublicURL(%q) accepted, want error", raw)
		}
	}
}
