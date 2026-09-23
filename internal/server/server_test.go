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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rphf/revue/internal/store"
)

// Tests re-read the repository on every request instead of once per
// interval, so a change on disk is visible to the next call.
func init() { refreshInterval = 0 }

// --- fixtures ---

const fixtureLines = 20

func fixtureContent(changed map[int]string) string {
	var b strings.Builder
	for i := 1; i <= fixtureLines; i++ {
		if line, ok := changed[i]; ok {
			b.WriteString(line)
		} else {
			fmt.Fprintf(&b, "line %d", i)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// The committed file has twenty lines, so an edit near the end and an
// edit at the top fall in different hunks.
func initRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q", "-b", "main")
	mustGit(t, dir, "config", "user.email", "test@test")
	mustGit(t, dir, "config", "user.name", "test")
	writeFile(t, dir, "a.txt", fixtureContent(nil))
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

// The edit every test starts from: line 15 changed in the worktree.
const changedLine = "line 15 CHANGED"

func (ts *testServer) modify(t *testing.T) {
	t.Helper()
	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{15: changedLine}))
}

type diffResponse struct {
	Args    []string       `json:"args"`
	Branch  string         `json:"branch"`
	Repo    string         `json:"repo"`
	Version int64          `json:"version"`
	Patch   string         `json:"patch"`
	Files   []fileView     `json:"files"`
	Anchors []positionView `json:"anchors"`
}

func argsQuery(args ...string) string {
	q := url.Values{}
	for _, a := range args {
		q.Add("arg", a)
	}
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}

func (ts *testServer) getDiff(t *testing.T, args ...string) *diffResponse {
	t.Helper()
	var out diffResponse
	resp := ts.do(t, "GET", "/api/diff"+argsQuery(args...), nil, &out)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/diff status = %d", resp.StatusCode)
	}
	return &out
}

func (ts *testServer) anchorOf(t *testing.T, threadID int64, args ...string) positionView {
	t.Helper()
	for _, a := range ts.getDiff(t, args...).Anchors {
		if a.ThreadID == threadID {
			return a
		}
	}
	t.Fatalf("thread %d has no anchor in the diff", threadID)
	return positionView{}
}

// draft starts a reviewer draft thread on a.txt in the default diff.
func (ts *testServer) draft(t *testing.T, line int, body string) int64 {
	t.Helper()
	var out struct {
		Thread *store.Thread `json:"thread"`
	}
	resp := ts.do(t, "POST", "/api/threads", map[string]any{
		"args": []string{}, "path": "a.txt", "side": "additions", "line": line, "body": body,
	}, &out)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("draft thread status = %d", resp.StatusCode)
	}
	return out.Thread.ID
}

func (ts *testServer) send(t *testing.T, note string) *store.Send {
	t.Helper()
	var out struct {
		Send *store.Send `json:"send"`
	}
	resp := ts.do(t, "POST", "/api/send", map[string]any{"note": note}, &out)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("send status = %d", resp.StatusCode)
	}
	return out.Send
}

type feedback struct {
	Cursor   int64          `json:"cursor"`
	Events   []*store.Event `json:"events"`
	Threads  []*threadView  `json:"threads"`
	LastSend *store.Send    `json:"lastSend"`
}

func (ts *testServer) feedback(t *testing.T, since int64) *feedback {
	t.Helper()
	var out feedback
	ts.do(t, "GET", fmt.Sprintf("/api/feedback?since=%d", since), nil, &out)
	return &out
}

// --- security ---

func TestRequestWithoutTokenRejected(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	resp, err := http.Get(ts.URL() + "/api/threads")
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
	req, _ := http.NewRequest("POST", ts.URL()+"/api/send", strings.NewReader(`{"note":"x"}`))
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
	req2, _ := http.NewRequest("GET", ts.URL()+"/api/threads", nil)
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
	next := url.QueryEscape("/?arg=main")
	resp, err := client.Get(ts.URL() + "/auth?token=" + ts.Token() + "&next=" + next)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("auth status = %d, want 303", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/?arg=main" {
		t.Errorf("redirect location = %q, want token-free /?arg=main", loc)
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
	req, _ := http.NewRequest("GET", ts.URL()+"/api/threads", nil)
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

// --- the live diff ---

func TestDiffValidatesArguments(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	for _, args := range [][]string{{"--ext-diff"}, {"nosuchref"}, {"--output=/tmp/x"}} {
		var out apiError
		resp := ts.do(t, "GET", "/api/diff"+argsQuery(args...), nil, &out)
		if resp.StatusCode != http.StatusBadRequest || out.Error != "validation" {
			t.Errorf("args %v: status %d, error %q; want 400 validation", args, resp.StatusCode, out.Error)
		}
	}
}

func TestDiffFollowsTheWorkingTree(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)

	// A clean tree is an empty diff, not an error.
	d := ts.getDiff(t)
	if len(d.Files) != 0 || strings.TrimSpace(d.Patch) != "" {
		t.Fatalf("clean tree: files = %v, patch = %q", d.Files, d.Patch)
	}
	if d.Branch != "main" || d.Repo != filepath.Base(ts.repo) || d.Version != 1 {
		t.Errorf("branch/repo/version = %s/%s/%d", d.Branch, d.Repo, d.Version)
	}
	if len(d.Args) != 0 {
		t.Errorf("args = %v, want empty", d.Args)
	}

	ts.modify(t)
	d = ts.getDiff(t)
	if len(d.Files) != 1 || d.Files[0].Path != "a.txt" || d.Files[0].Status != "modified" {
		t.Fatalf("after edit: files = %+v", d.Files)
	}
	if !strings.Contains(d.Patch, "+"+changedLine) || d.Version != 2 {
		t.Errorf("after edit: version %d, patch %q", d.Version, d.Patch)
	}

	// Untracked files join the default diff as added files.
	writeFile(t, ts.repo, "b.txt", "new file\n")
	d = ts.getDiff(t)
	if len(d.Files) != 2 || d.Files[1].Path != "b.txt" || d.Files[1].Status != "added" {
		t.Errorf("with untracked: files = %+v", d.Files)
	}
	if d.Version != 3 {
		t.Errorf("version = %d, want 3", d.Version)
	}

	// Another argument list is another view with its own version.
	staged := ts.getDiff(t, "--staged")
	if len(staged.Files) != 0 || staged.Version != 1 || len(staged.Args) != 1 {
		t.Errorf("staged view: %+v", staged)
	}

	// Nothing changed: the version holds.
	if again := ts.getDiff(t); again.Version != 3 {
		t.Errorf("unchanged tree bumped the version to %d", again.Version)
	}
}

func TestDiffFileServesCurrentContents(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	var out struct {
		Path       string  `json:"path"`
		Status     string  `json:"status"`
		OldContent *string `json:"oldContent"`
		NewContent *string `json:"newContent"`
	}
	resp := ts.do(t, "GET", "/api/diff/file?path=a.txt", nil, &out)
	ts.mustStatus(t, resp, http.StatusOK)
	if out.OldContent == nil || !strings.Contains(*out.OldContent, "line 15\n") {
		t.Errorf("oldContent = %v", out.OldContent)
	}
	if out.NewContent == nil || !strings.Contains(*out.NewContent, changedLine) {
		t.Errorf("newContent = %v", out.NewContent)
	}
	for path, want := range map[string]int{
		"/api/diff/file?path=missing.txt": http.StatusNotFound,
		"/api/diff/file":                  http.StatusBadRequest,
	} {
		resp := ts.do(t, "GET", path, nil, nil)
		ts.mustStatus(t, resp, want)
		_ = resp.Body.Close()
	}
}

// --- threads ---

func TestThreadFollowsItsHunkAcrossEdits(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "on the changed line")

	a := ts.anchorOf(t, id)
	if a.State != "live" || a.Path != "a.txt" || a.Line != 15 {
		t.Fatalf("fresh thread: %+v, want live at a.txt:15", a)
	}

	// Lines added at the top shift the hunk without changing it.
	writeFile(t, ts.repo, "a.txt", "new A\nnew B\nnew C\n"+fixtureContent(map[int]string{15: changedLine}))
	if a = ts.anchorOf(t, id); a.State != "live" || a.Line != 18 {
		t.Errorf("after shift: %+v, want live at 18", a)
	}

	// Rewriting the commented line outdates the thread, at its origin.
	writeFile(t, ts.repo, "a.txt", "new A\nnew B\nnew C\n"+fixtureContent(map[int]string{15: "line 15 REWRITTEN"}))
	if a = ts.anchorOf(t, id); a.State != "outdated" || a.Line != 15 {
		t.Errorf("after rewrite: %+v, want outdated at origin 15", a)
	}

	// The content comes back: so does the thread.
	ts.modify(t)
	if a = ts.anchorOf(t, id); a.State != "live" || a.Line != 15 {
		t.Errorf("after restore: %+v, want live at 15", a)
	}

	// A different diff of the same tree places the thread on its own
	// terms: the staged diff has no hunk for it.
	if a = ts.anchorOf(t, id, "--staged"); a.State != "outdated" {
		t.Errorf("in the staged view: %+v, want outdated", a)
	}
}

func TestCreateThreadValidatesAndDetectsStaleDiff(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)

	var out apiError
	resp := ts.do(t, "POST", "/api/threads", map[string]any{"path": "a.txt", "side": "sideways", "line": 1, "body": "x"}, &out)
	if resp.StatusCode != http.StatusBadRequest || out.Error != "validation" {
		t.Errorf("bad side: %d %s", resp.StatusCode, out.Error)
	}
	resp = ts.do(t, "POST", "/api/threads", map[string]any{"args": []string{"--ext-diff"}, "path": "a.txt", "side": "additions", "line": 1, "body": "x"}, &out)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bad args: %d", resp.StatusCode)
	}

	// The file left the diff between the page load and the comment.
	writeFile(t, ts.repo, "a.txt", fixtureContent(nil))
	resp = ts.do(t, "POST", "/api/threads", map[string]any{"args": []string{}, "path": "a.txt", "side": "additions", "line": 15, "body": "late"}, &out)
	if resp.StatusCode != http.StatusConflict || out.Error != "stale_diff" {
		t.Errorf("stale: status %d, error %q; want 409 stale_diff", resp.StatusCode, out.Error)
	}
}

func TestSnapshotKeepsTheFileAsItWas(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "remember this")
	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{15: "line 15 AGAIN"}))

	var snap struct {
		Path       string    `json:"path"`
		Status     string    `json:"status"`
		OldContent string    `json:"oldContent"`
		NewContent string    `json:"newContent"`
		CreatedAt  time.Time `json:"createdAt"`
	}
	resp := ts.do(t, "GET", fmt.Sprintf("/api/threads/%d/snapshot", id), nil, &snap)
	ts.mustStatus(t, resp, http.StatusOK)
	if snap.Path != "a.txt" || snap.Status != "modified" || snap.CreatedAt.IsZero() {
		t.Errorf("snapshot meta = %+v", snap)
	}
	if snap.OldContent != fixtureContent(nil) {
		t.Errorf("oldContent = %q", snap.OldContent)
	}
	if snap.NewContent != fixtureContent(map[int]string{15: changedLine}) {
		t.Errorf("newContent = %q, want the file at thread creation", snap.NewContent)
	}
	resp = ts.do(t, "GET", "/api/threads/999/snapshot", nil, nil)
	ts.mustStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()
}

// --- send and feedback ---

func TestSendDeliversDraftsAtomically(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "fix this")

	// Before the send: invisible to every agent-facing read.
	var listed struct {
		Threads []*threadView `json:"threads"`
	}
	ts.do(t, "GET", "/api/threads", nil, &listed)
	if len(listed.Threads) != 0 {
		t.Fatalf("draft visible in /api/threads: %d", len(listed.Threads))
	}
	fb := ts.feedback(t, 0)
	if len(fb.Threads) != 0 || len(fb.Events) != 0 || fb.LastSend != nil {
		t.Fatalf("draft leaked into feedback: %+v", fb)
	}
	// The reviewer's own UI sees it as a draft.
	ts.do(t, "GET", "/api/threads?drafts=1", nil, &listed)
	if len(listed.Threads) != 1 || !listed.Threads[0].Comments[0].Draft {
		t.Fatalf("drafts=1 listing = %+v", listed.Threads)
	}

	var sent struct {
		Send    *store.Send   `json:"send"`
		Threads []*threadView `json:"threads"`
	}
	resp := ts.do(t, "POST", "/api/send", map[string]any{"note": "please"}, &sent)
	ts.mustStatus(t, resp, http.StatusCreated)
	if sent.Send.Note != "please" || len(sent.Threads) != 1 || sent.Threads[0].ID != id {
		t.Errorf("send response = %+v", sent)
	}

	fb = ts.feedback(t, 0)
	if len(fb.Threads) != 1 {
		t.Fatalf("threads after send = %d", len(fb.Threads))
	}
	th := fb.Threads[0]
	if th.Quote == nil || strings.Join(th.Quote.Lines, "\n") != changedLine || th.Quote.Path != "a.txt" || th.Quote.Line != 15 {
		t.Errorf("quote = %+v", th.Quote)
	}
	if len(th.Comments) != 1 || th.Comments[0].Draft || th.Comments[0].SendID == nil || *th.Comments[0].SendID != sent.Send.ID {
		t.Errorf("comments = %+v", th.Comments)
	}
	if fb.LastSend == nil || fb.LastSend.Note != "please" {
		t.Errorf("lastSend = %+v", fb.LastSend)
	}
	if len(fb.Events) != 1 || fb.Events[0].Type != eventSent || fb.Cursor != fb.Events[0].ID {
		t.Fatalf("events = %+v, cursor = %d", fb.Events, fb.Cursor)
	}
	var payload struct {
		Send    *store.Send   `json:"send"`
		Threads []*threadView `json:"threads"`
	}
	if err := json.Unmarshal(fb.Events[0].Payload, &payload); err != nil || payload.Send.ID != sent.Send.ID || len(payload.Threads) != 1 {
		t.Errorf("sent payload = %s (%v)", fb.Events[0].Payload, err)
	}
}

func TestSendWithNothingIsRefusedAndNoteAloneIsNot(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	var out apiError
	resp := ts.do(t, "POST", "/api/send", map[string]any{"note": ""}, &out)
	if resp.StatusCode != http.StatusBadRequest || out.Error != "validation" {
		t.Errorf("empty send: %d %s", resp.StatusCode, out.Error)
	}
	sd := ts.send(t, "LGTM")
	fb := ts.feedback(t, 0)
	if fb.LastSend == nil || fb.LastSend.ID != sd.ID || len(fb.Threads) != 0 {
		t.Errorf("note-only send: %+v", fb)
	}
}

func TestSendsListEverySendOldestFirst(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	var out struct {
		Sends []*store.Send `json:"sends"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/sends", nil, &out), http.StatusOK)
	if out.Sends == nil || len(out.Sends) != 0 {
		t.Fatalf("sends before any send = %+v", out.Sends)
	}
	first := ts.send(t, "first")
	second := ts.send(t, "second")
	ts.mustStatus(t, ts.do(t, "GET", "/api/sends", nil, &out), http.StatusOK)
	if len(out.Sends) != 2 || out.Sends[0].ID != first.ID || out.Sends[1].ID != second.ID || out.Sends[1].Note != "second" {
		t.Errorf("sends = %+v", out.Sends)
	}
}

func TestSinceReplayReturnsExactlyMissedEvents(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "first")
	ts.send(t, "")
	cursor := ts.feedback(t, 0).Cursor

	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", id), map[string]any{"role": "agent", "body": "done"}, nil)
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/resolve", id), map[string]any{}, nil)

	fb := ts.feedback(t, cursor)
	if len(fb.Events) != 2 || fb.Events[0].Type != eventReplied || fb.Events[1].Type != eventResolved {
		t.Fatalf("events since %d = %+v", cursor, fb.Events)
	}
	if fb.Cursor <= cursor {
		t.Errorf("cursor did not advance: %d", fb.Cursor)
	}
	again := ts.feedback(t, fb.Cursor)
	if len(again.Events) != 0 || again.Cursor != fb.Cursor {
		t.Errorf("replay past the end: %+v", again)
	}
}

func TestWaitUnblocksOnSendAndTimesOutDistinctly(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	ts.draft(t, 15, "pending")

	var out waitOutcome
	resp := ts.do(t, "GET", "/api/wait?timeout=100ms", nil, &out)
	ts.mustStatus(t, resp, http.StatusOK)
	if out.Outcome != "timeout" {
		t.Fatalf("outcome = %s, want timeout", out.Outcome)
	}

	done := make(chan waitOutcome, 1)
	go func() {
		var got waitOutcome
		ts.do(t, "GET", "/api/wait?timeout=5s", nil, &got)
		done <- got
	}()
	time.Sleep(100 * time.Millisecond)
	sd := ts.send(t, "go")
	select {
	case got := <-done:
		if got.Outcome != "sent" || got.Send == nil || got.Send.ID != sd.ID || got.Send.Note != "go" {
			t.Errorf("wait outcome = %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("wait did not return after the send")
	}

	// A send that landed while nobody waited is delivered by the next wait.
	ts.draft(t, 16, "another")
	late := ts.send(t, "late")
	var got waitOutcome
	ts.do(t, "GET", fmt.Sprintf("/api/wait?since=%d&timeout=1s", out.Cursor), nil, &got)
	if got.Outcome != "sent" || got.Send == nil || got.Send.ID != sd.ID {
		t.Errorf("first missed send: %+v, want send %d", got, sd.ID)
	}
	ts.do(t, "GET", fmt.Sprintf("/api/wait?since=%d&timeout=1s", got.Cursor), nil, &got)
	if got.Outcome != "sent" || got.Send == nil || got.Send.ID != late.ID {
		t.Errorf("second missed send: %+v, want send %d", got, late.ID)
	}
}

func TestAgentReplyIsEventedAndReviewerReplyIsADraft(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "question")
	ts.send(t, "")
	cursor := ts.feedback(t, 0).Cursor

	var reviewer struct {
		Comment *store.Comment `json:"comment"`
		Cursor  *int64         `json:"cursor"`
	}
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", id), map[string]any{"role": "reviewer", "body": "follow-up"}, &reviewer)
	if !reviewer.Comment.Draft || reviewer.Cursor != nil {
		t.Errorf("reviewer reply = %+v, want a draft with no cursor", reviewer)
	}

	var agent struct {
		Comment *store.Comment `json:"comment"`
		Cursor  int64          `json:"cursor"`
	}
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", id), map[string]any{"role": "agent", "body": "answer"}, &agent)
	if agent.Comment.Draft || agent.Cursor <= cursor {
		t.Errorf("agent reply = %+v", agent)
	}

	fb := ts.feedback(t, cursor)
	if len(fb.Events) != 1 || fb.Events[0].Type != eventReplied {
		t.Errorf("events = %+v", fb.Events)
	}
	bodies := []string{}
	for _, c := range fb.Threads[0].Comments {
		bodies = append(bodies, c.Body)
	}
	if strings.Join(bodies, ",") != "question,answer" {
		t.Errorf("visible comments = %v; the reviewer's draft must stay hidden", bodies)
	}

	// Resolving takes the thread out of the agent's list; unresolving brings it back.
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/resolve", id), map[string]any{}, nil)
	if fb := ts.feedback(t, 0); len(fb.Threads) != 0 {
		t.Errorf("resolved thread still in feedback: %d", len(fb.Threads))
	}
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/unresolve", id), map[string]any{}, nil)
	fb = ts.feedback(t, 0)
	if len(fb.Threads) != 1 {
		t.Errorf("unresolved thread missing from feedback")
	}
	if n := len(fb.Events); n != 4 || fb.Events[3].Type != eventUnresolved {
		t.Errorf("event log = %d events, last %q", n, fb.Events[n-1].Type)
	}

	resp := ts.do(t, "POST", "/api/threads/999/comments", map[string]any{"role": "agent", "body": "x"}, nil)
	ts.mustStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()
}

// --- SSE ---

type sseFrame struct {
	ID      *int64          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func readFrames(t *testing.T, body io.Reader) <-chan sseFrame {
	t.Helper()
	frames := make(chan sseFrame, 16)
	go func() {
		scanner := bufio.NewScanner(body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var f sseFrame
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &f); err == nil {
				frames <- f
			}
		}
	}()
	return frames
}

func nextFrame(t *testing.T, frames <-chan sseFrame, wait time.Duration) sseFrame {
	t.Helper()
	select {
	case f := <-frames:
		return f
	case <-time.After(wait):
		t.Fatal("no SSE frame in time")
		return sseFrame{}
	}
}

func TestSSEStreamsDiffChangesReplayAndLiveEvents(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "hello")
	ts.send(t, "")

	req, _ := http.NewRequest("GET", ts.URL()+"/api/events?since=0", nil)
	req.Header.Set("Authorization", "Bearer "+ts.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %s", ct)
	}
	frames := readFrames(t, resp.Body)

	// The stream opens with the diff's current version, then replays.
	first := nextFrame(t, frames, 3*time.Second)
	if first.Type != eventDiffChanged || first.ID != nil {
		t.Fatalf("first frame = %+v, want an id-less diff.changed", first)
	}
	var notice struct {
		Version int64 `json:"version"`
	}
	_ = json.Unmarshal(first.Payload, &notice)
	if notice.Version != ts.getDiff(t).Version {
		t.Errorf("notice version = %d, diff version = %d", notice.Version, ts.getDiff(t).Version)
	}
	if replayed := nextFrame(t, frames, 3*time.Second); replayed.Type != eventSent || replayed.ID == nil {
		t.Fatalf("replayed frame = %+v, want sent with an id", replayed)
	}

	// Live: an agent reply arrives without reconnecting.
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", id), map[string]any{"role": "agent", "body": "hi"}, nil)
	if live := nextFrame(t, frames, 3*time.Second); live.Type != eventReplied {
		t.Fatalf("live frame = %+v, want thread.replied", live)
	}

	// The tree changes: the next poll tick notices.
	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{15: "line 15 EDITED"}))
	changed := nextFrame(t, frames, 4*time.Second)
	if changed.Type != eventDiffChanged {
		t.Fatalf("after edit frame = %+v, want diff.changed", changed)
	}
	_ = json.Unmarshal(changed.Payload, &notice)
	if notice.Version != ts.getDiff(t).Version {
		t.Errorf("changed version = %d, diff version = %d", notice.Version, ts.getDiff(t).Version)
	}
}

// --- lifecycle ---

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
	for kind, path := range map[string]string{"sse": "/api/events", "wait": "/api/wait?timeout=10s"} {
		t.Run(kind, func(t *testing.T) {
			ts := startServer(t, initRepo(t), 150*time.Millisecond)
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
		req, _ := http.NewRequest("GET", s.URL()+"/api/threads", nil)
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
	if got := st.AuthURL("/?arg=main"); got != "http://agent1.localhost:3191/auth?token="+s.Token()+"&next=%2F%3Farg%3Dmain" {
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

func TestHealthReportsBuildAndProbeReadsIt(t *testing.T) {
	repo := initRepo(t)
	s, err := Start(Config{RepoRoot: repo, DataDir: t.TempDir(), BuildStamp: "build-A"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.Shutdown(ctx)
		cancel()
	}()
	st := &State{Port: s.ln.Addr().(*net.TCPAddr).Port, Token: s.Token(), PID: os.Getpid()}
	build, ok := probe(st)
	if !ok || build != "build-A" {
		t.Fatalf("probe = (%q, %v), want (build-A, true)", build, ok)
	}
	if BuildStamp() == "" || BuildStamp() == "build-A" {
		t.Errorf("BuildStamp() = %q, want the test binary's own stamp", BuildStamp())
	}
	if !Healthy(st) {
		t.Error("Healthy should still hold for a live server of any build")
	}
}

// --- export ---

func TestExportRendersMarkdownWithoutDrafts(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "sent comment")
	ts.send(t, "fix line fifteen")
	ts.do(t, "POST", fmt.Sprintf("/api/threads/%d/comments", id), map[string]any{"role": "agent", "body": "agent reply"}, nil)
	ts.draft(t, 16, "unsent draft")

	resp := ts.do(t, "GET", "/api/export", nil, nil)
	ts.mustStatus(t, resp, http.StatusOK)
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/markdown") {
		t.Errorf("content type = %q, want text/markdown", ct)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	md := string(body)
	for _, want := range []string{
		"# Threads in " + filepath.Base(ts.repo),
		"- Threads: 1, 1 unresolved",
		"## a.txt",
		"### Thread ",
		"`a.txt:15` (additions, ",
		changedLine,
		"**reviewer**",
		"sent comment",
		"**agent**",
		"agent reply",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("export missing %q:\n%s", want, md)
		}
	}
	if strings.Contains(md, "unsent draft") {
		t.Errorf("draft leaked into the export:\n%s", md)
	}
}

// --- assets ---

func TestAssetServesImagesFromTheCheckout(t *testing.T) {
	repo := initRepo(t)
	if err := os.MkdirAll(filepath.Join(repo, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	svg := `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`
	writeFile(t, repo, "docs/logo.svg", svg)
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0}
	if err := os.WriteFile(filepath.Join(repo, "pic.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	ts := startServer(t, repo, 0)
	get := func(p string) *http.Response {
		return ts.do(t, "GET", "/api/asset?path="+url.QueryEscape(p), nil, nil)
	}
	read := func(resp *http.Response) []byte {
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return body
	}

	resp := get("docs/logo.svg")
	ts.mustStatus(t, resp, http.StatusOK)
	for header, want := range map[string]string{
		"Content-Type":            "image/svg+xml",
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
	} {
		if got := resp.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if got := string(read(resp)); got != svg {
		t.Errorf("svg body = %q", got)
	}

	// The checkout is live: an edit on disk shows on the next request.
	writeFile(t, repo, "docs/logo.svg", "<svg>changed</svg>")
	resp = get("docs/logo.svg")
	ts.mustStatus(t, resp, http.StatusOK)
	if got := string(read(resp)); got != "<svg>changed</svg>" {
		t.Errorf("after edit body = %q, want the current file", got)
	}

	resp = get("pic.png")
	ts.mustStatus(t, resp, http.StatusOK)
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("png content type = %q", ct)
	}
	if got := read(resp); !bytes.Equal(got, png) {
		t.Errorf("png body = %v, want %v", got, png)
	}

	for p, want := range map[string]int{
		"../outside.svg":  http.StatusBadRequest,
		"/etc/passwd.png": http.StatusBadRequest,
		"a.txt":           http.StatusUnsupportedMediaType,
		"missing.png":     http.StatusNotFound,
	} {
		resp = get(p)
		ts.mustStatus(t, resp, want)
		_ = resp.Body.Close()
	}
}

func TestDiffImageServesEachSideFromTheDiff(t *testing.T) {
	repo := initRepo(t)
	pngV1 := []byte{0x89, 'P', 'N', 'G', 0, 1}
	pngV2 := []byte{0x89, 'P', 'N', 'G', 0, 2, 3}
	gone := []byte{0x89, 'P', 'N', 'G', 0, 9, 9, 9}
	for p, b := range map[string][]byte{"pic.png": pngV1, "gone.png": gone} {
		if err := os.WriteFile(filepath.Join(repo, p), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "images")
	if err := os.WriteFile(filepath.Join(repo, "pic.png"), pngV2, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repo, "gone.png")); err != nil {
		t.Fatal(err)
	}
	fresh := []byte{0x89, 'P', 'N', 'G', 0}
	if err := os.WriteFile(filepath.Join(repo, "new.png"), fresh, 0o644); err != nil {
		t.Fatal(err)
	}
	ts := startServer(t, repo, 0)

	sizes := map[string][2]int64{}
	for _, f := range ts.getDiff(t).Files {
		var s [2]int64
		s[0], s[1] = -1, -1
		if f.OldSize != nil {
			s[0] = *f.OldSize
		}
		if f.NewSize != nil {
			s[1] = *f.NewSize
		}
		sizes[f.Path] = s
	}
	for p, want := range map[string][2]int64{
		"pic.png":  {int64(len(pngV1)), int64(len(pngV2))},
		"gone.png": {int64(len(gone)), -1},
		"new.png":  {-1, int64(len(fresh))},
	} {
		if sizes[p] != want {
			t.Errorf("%s sizes = %v, want %v (old, new; -1 absent)", p, sizes[p], want)
		}
	}

	get := func(p, side string) *http.Response {
		q := url.Values{"path": {p}, "side": {side}}
		return ts.do(t, "GET", "/api/diff/image?"+q.Encode(), nil, nil)
	}
	for _, tc := range []struct {
		path, side string
		want       []byte
	}{
		{"pic.png", "old", pngV1},
		{"pic.png", "new", pngV2},
		{"gone.png", "old", gone},
		{"new.png", "new", fresh},
	} {
		resp := get(tc.path, tc.side)
		ts.mustStatus(t, resp, http.StatusOK)
		if csp := resp.Header.Get("Content-Security-Policy"); csp != "default-src 'none'; sandbox" {
			t.Errorf("%s %s: CSP = %q", tc.path, tc.side, csp)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if !bytes.Equal(body, tc.want) {
			t.Errorf("%s %s = %v, want %v", tc.path, tc.side, body, tc.want)
		}
	}
	for _, tc := range []struct {
		path, side string
		want       int
	}{
		{"gone.png", "new", http.StatusNotFound},
		{"new.png", "old", http.StatusNotFound},
		{"other.png", "new", http.StatusNotFound},
		{"a.txt", "new", http.StatusUnsupportedMediaType},
		{"pic.png", "both", http.StatusBadRequest},
	} {
		resp := get(tc.path, tc.side)
		ts.mustStatus(t, resp, tc.want)
		_ = resp.Body.Close()
	}
}
