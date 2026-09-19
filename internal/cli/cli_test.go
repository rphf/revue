package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rphf/revue/internal/server"
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
	writeFile(t, dir, "main.go", "package main\n\nfunc main() {\n\tprintln(\"v1\")\n}\n")
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

type harness struct {
	*env
	t      *testing.T
	repo   string
	srv    *server.Server
	out    *bytes.Buffer
	errOut *bytes.Buffer
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	repo := initRepo(t)
	srv, err := server.Start(server.Config{RepoRoot: repo, DataDir: t.TempDir()})
	if err != nil {
		t.Fatalf("server.Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	return &harness{
		env: &env{
			client:    &Client{BaseURL: srv.URL(), Token: srv.Token(), HTTP: &http.Client{}},
			publicURL: srv.PublicURL(),
			repoRoot:  repo,
			branch:    "main",
			stdout:    out,
			stderr:    errOut,
			openURL:   func(string) error { return nil },
		},
		t: t, repo: repo, srv: srv, out: out, errOut: errOut,
	}
}

// run resets output buffers and runs a command function.
func (h *harness) run(fn func([]string) int, args ...string) (int, string) {
	h.t.Helper()
	h.out.Reset()
	h.errOut.Reset()
	code := fn(args)
	return code, h.out.String()
}

// modify makes the worktree diff non-empty (or different).
func (h *harness) modify(content string) {
	writeFile(h.t, h.repo, "main.go", content)
}

// openReview opens a working-tree review and returns its id + cursor.
func (h *harness) openReview() (int64, int64) {
	h.t.Helper()
	h.modify("package main\n\nfunc main() {\n\tprintln(\"v2\")\n}\n")
	code, out := h.run(h.cmdOpen, "--no-browser")
	if code != ExitOK {
		h.t.Fatalf("open failed (%d): %s", code, out)
	}
	var parsed struct {
		Review struct {
			ID int64 `json:"id"`
		} `json:"review"`
		Cursor int64  `json:"cursor"`
		URL    string `json:"url"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		h.t.Fatalf("open output not JSON: %v\n%s", err, out)
	}
	if parsed.URL == "" {
		h.t.Fatal("open output missing url")
	}
	return parsed.Review.ID, parsed.Cursor
}

// reviewerDraft creates a reviewer draft thread via the HTTP API (the
// reviewer normally acts through the browser).
func (h *harness) reviewerDraft(reviewID int64, line int, body string) int64 {
	h.t.Helper()
	var out struct {
		Thread struct {
			ID int64 `json:"id"`
		} `json:"thread"`
	}
	if err := h.client.do("POST", fmt.Sprintf("/api/reviews/%d/threads", reviewID), map[string]any{
		"path": "main.go", "side": "additions", "line": line, "body": body,
	}, &out); err != nil {
		h.t.Fatalf("draft: %v", err)
	}
	return out.Thread.ID
}

func (h *harness) reviewerSubmit(reviewID int64, verdict, summary string) {
	h.t.Helper()
	if err := h.client.do("POST", fmt.Sprintf("/api/reviews/%d/submit", reviewID), map[string]any{
		"verdict": verdict, "summary": summary,
	}, nil); err != nil {
		h.t.Fatalf("submit: %v", err)
	}
}

func (h *harness) reviewerClose(reviewID int64) {
	h.t.Helper()
	if err := h.client.do("POST", fmt.Sprintf("/api/reviews/%d/close", reviewID), map[string]any{}, nil); err != nil {
		h.t.Fatalf("close: %v", err)
	}
}

// --- tests ---

func TestOpenEmptyDiffRefusesWithNotice(t *testing.T) {
	h := newHarness(t)
	code, out := h.run(h.cmdOpen, "--no-browser")
	if code != ExitValidation {
		t.Errorf("exit = %d, want %d (validation)", code, ExitValidation)
	}
	if !strings.Contains(out, "empty_diff") {
		t.Errorf("output missing empty_diff notice: %s", out)
	}
}

func TestOpenRejectsFlagShapedArgs(t *testing.T) {
	h := newHarness(t)
	code, out := h.run(h.cmdOpen, "--no-browser", "--ext-diff=echo pwned")
	if code != ExitValidation {
		t.Errorf("flag injection exit = %d, want %d: %s", code, ExitValidation, out)
	}
}

func TestFeedbackReturnsQuotedSnapshotContext(t *testing.T) {
	h := newHarness(t)
	id, cursor := h.openReview()
	h.reviewerDraft(id, 4, "prefer fmt.Println here")
	h.reviewerSubmit(id, "request_changes", "one change")

	code, out := h.run(h.cmdFeedback, "--review", fmt.Sprint(id), "--since", fmt.Sprint(cursor))
	if code != ExitOK {
		t.Fatalf("feedback exit = %d: %s", code, out)
	}
	var fb struct {
		Verdict string `json:"verdict"`
		Threads []struct {
			Comments []struct {
				Body string `json:"body"`
			} `json:"comments"`
			Quote *struct {
				Path      string   `json:"path"`
				Side      string   `json:"side"`
				StartLine int      `json:"startLine"`
				Line      int      `json:"line"`
				Lines     []string `json:"lines"`
			} `json:"quote"`
		} `json:"threads"`
		Events []struct {
			Type string `json:"type"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(out), &fb); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if fb.Verdict != "request_changes" {
		t.Errorf("verdict = %q (R13)", fb.Verdict)
	}
	if len(fb.Threads) != 1 || fb.Threads[0].Quote == nil {
		t.Fatalf("missing thread quote: %s", out)
	}
	q := fb.Threads[0].Quote
	if q.Path != "main.go" || q.Side != "additions" || q.Line != 4 {
		t.Errorf("quote anchor = %+v", q)
	}
	if len(q.Lines) != 1 || !strings.Contains(q.Lines[0], `println("v2")`) {
		t.Errorf("quoted lines = %v, want the snapshot line", q.Lines)
	}
}

func TestFeedbackGolden(t *testing.T) {
	h := newHarness(t)
	id, _ := h.openReview()
	threadID := h.reviewerDraft(id, 4, "prefer fmt.Println here")
	h.reviewerSubmit(id, "request_changes", "one change")
	if _, out := h.run(h.cmdReply, "--thread", fmt.Sprint(threadID), "-m", "done, switched to fmt.Println"); out == "" {
		t.Fatal("reply produced no output")
	}

	code, out := h.run(h.cmdFeedback, "--review", fmt.Sprint(id))
	if code != ExitOK {
		t.Fatalf("feedback exit = %d", code)
	}
	got := scrubDynamic(out, h.repo)

	golden := filepath.Join("testdata", "feedback.golden.json")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (run with UPDATE_GOLDEN=1 to create): %v", err)
	}
	if got != string(want) {
		t.Errorf("feedback payload shape drifted from golden.\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

var (
	timeRe = regexp.MustCompile(`"(createdAt|updatedAt)": "[^"]*"`)
	hashRe = regexp.MustCompile(`"hunkHash": "[0-9a-f]{8,}"`)
)

// scrubDynamic pins the golden file to shape, not to timestamps or
// machine-local paths.
func scrubDynamic(s, repo string) string {
	s = strings.ReplaceAll(s, repo, "REPO_ROOT")
	s = timeRe.ReplaceAllString(s, `"$1": "TIME"`)
	s = hashRe.ReplaceAllString(s, `"hunkHash": "HASH"`)
	return s
}

func TestAE6SinceReturnsOnlyNewItemsAcrossWaits(t *testing.T) {
	h := newHarness(t)
	id, cursor := h.openReview()

	// First wait times out with nothing new.
	code, out := h.run(h.cmdWait, "--review", fmt.Sprint(id), "--since", fmt.Sprint(cursor), "--timeout", "150ms")
	if code != ExitWaitTimeout {
		t.Fatalf("wait exit = %d, want %d (timeout): %s", code, ExitWaitTimeout, out)
	}

	// A submission lands while NO wait is active.
	h.reviewerDraft(id, 4, "please fix")
	h.reviewerSubmit(id, "request_changes", "")

	// Re-invocation delivers it exactly as if the agent had been waiting.
	code, out = h.run(h.cmdWait, "--review", fmt.Sprint(id), "--since", fmt.Sprint(cursor), "--timeout", "5s")
	if code != ExitOK {
		t.Fatalf("wait exit = %d, want 0: %s", code, out)
	}
	var wo struct {
		Outcome    string         `json:"outcome"`
		Cursor     int64          `json:"cursor"`
		Submission map[string]any `json:"submission"`
	}
	if err := json.Unmarshal([]byte(out), &wo); err != nil {
		t.Fatal(err)
	}
	if wo.Outcome != "submitted" || wo.Submission == nil {
		t.Fatalf("outcome = %+v", wo)
	}

	// The cursor advances: feedback since the new cursor is empty.
	code, out = h.run(h.cmdFeedback, "--review", fmt.Sprint(id), "--since", fmt.Sprint(wo.Cursor))
	if code != ExitOK {
		t.Fatal("feedback failed")
	}
	var fb struct {
		Events []any `json:"events"`
	}
	_ = json.Unmarshal([]byte(out), &fb)
	if len(fb.Events) != 0 {
		t.Errorf("events past cursor = %d, want 0", len(fb.Events))
	}
}

func TestWaitReturnsPromptlyOnSubmit(t *testing.T) {
	h := newHarness(t)
	id, cursor := h.openReview()

	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(150 * time.Millisecond)
		_ = h.client.do("POST", fmt.Sprintf("/api/reviews/%d/submit", id), map[string]any{"verdict": "approve"}, nil)
	}()

	start := time.Now()
	code, out := h.run(h.cmdWait, "--review", fmt.Sprint(id), "--since", fmt.Sprint(cursor), "--timeout", "30s")
	<-done
	if code != ExitOK {
		t.Fatalf("wait exit = %d: %s", code, out)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("wait took %s; should return promptly on submit", elapsed)
	}
	if !strings.Contains(out, `"approve"`) {
		t.Errorf("wait output missing verdict: %s", out)
	}
}

func TestAE8WaitExitsDistinctlyOnClose(t *testing.T) {
	h := newHarness(t)
	id, cursor := h.openReview()

	go func() {
		time.Sleep(150 * time.Millisecond)
		h.reviewerClose(id)
	}()

	code, out := h.run(h.cmdWait, "--review", fmt.Sprint(id), "--since", fmt.Sprint(cursor), "--timeout", "30s")
	if code != ExitClosed {
		t.Fatalf("wait exit = %d, want %d (closed distinct from submission): %s", code, ExitClosed, out)
	}
	if !strings.Contains(out, `"closed"`) {
		t.Errorf("output missing closed outcome: %s", out)
	}
}

func TestWaitWithNoOpenReviewExitsDistinctly(t *testing.T) {
	h := newHarness(t)
	code, out := h.run(h.cmdWait, "--timeout", "1s")
	if code != ExitNoOpenReview {
		t.Errorf("exit = %d, want %d: %s", code, ExitNoOpenReview, out)
	}
	if !strings.Contains(out, "no_open_review") {
		t.Errorf("output missing no_open_review: %s", out)
	}
}

func TestAE9ReplyToApprovedReviewIsMachineReadableError(t *testing.T) {
	h := newHarness(t)
	id, _ := h.openReview()
	threadID := h.reviewerDraft(id, 4, "nit")
	h.reviewerSubmit(id, "approve", "lgtm")

	code, out := h.run(h.cmdReply, "--thread", fmt.Sprint(threadID), "-m", "but wait")
	if code != ExitReadOnly {
		t.Fatalf("exit = %d, want %d (read-only): %s", code, ExitReadOnly, out)
	}
	var apiErr APIError
	if err := json.Unmarshal([]byte(out), &apiErr); err != nil {
		t.Fatalf("error not machine-readable JSON: %v\n%s", err, out)
	}
	if apiErr.Code != "review_approved" {
		t.Errorf("error code = %q, want review_approved", apiErr.Code)
	}
}

func TestReplyPostsAgentComment(t *testing.T) {
	h := newHarness(t)
	id, _ := h.openReview()
	threadID := h.reviewerDraft(id, 4, "why?")
	h.reviewerSubmit(id, "comment", "")

	code, out := h.run(h.cmdReply, "--thread", fmt.Sprint(threadID), "-m", "because")
	if code != ExitOK {
		t.Fatalf("reply exit = %d: %s", code, out)
	}
	var reply struct {
		Comment struct {
			AuthorRole string `json:"authorRole"`
			Draft      bool   `json:"draft"`
		} `json:"comment"`
		Cursor int64 `json:"cursor"`
	}
	if err := json.Unmarshal([]byte(out), &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Comment.AuthorRole != "agent" || reply.Comment.Draft {
		t.Errorf("reply comment = %+v", reply.Comment)
	}
	if reply.Cursor == 0 {
		t.Error("reply missing cursor")
	}
}

func TestRoundSignalAndIdenticalDedupe(t *testing.T) {
	h := newHarness(t)
	id, _ := h.openReview()

	// Identical diff: no-op with notice (KTD12).
	code, out := h.run(h.cmdRound, "--review", fmt.Sprint(id))
	if code != ExitOK {
		t.Fatalf("round exit = %d: %s", code, out)
	}
	var res struct {
		Deduped bool   `json:"deduped"`
		Notice  string `json:"notice"`
		Round   struct {
			Seq int `json:"seq"`
		} `json:"round"`
	}
	_ = json.Unmarshal([]byte(out), &res)
	if !res.Deduped || res.Notice == "" || res.Round.Seq != 1 {
		t.Errorf("dedupe result = %+v", res)
	}

	// Changed diff: a real round 2.
	h.modify("package main\n\nfunc main() {\n\tprintln(\"v3\")\n}\n")
	code, out = h.run(h.cmdRound, "--review", fmt.Sprint(id))
	if code != ExitOK {
		t.Fatalf("round exit = %d: %s", code, out)
	}
	_ = json.Unmarshal([]byte(out), &res)
	if res.Deduped || res.Round.Seq != 2 {
		t.Errorf("round 2 result = %+v", res)
	}
}

func TestReviewsListsAndDefaultResolution(t *testing.T) {
	h := newHarness(t)
	code, out := h.run(h.cmdFeedback)
	if code != ExitNoOpenReview {
		t.Errorf("feedback with no reviews: exit = %d, want %d: %s", code, ExitNoOpenReview, out)
	}

	id, _ := h.openReview()
	code, out = h.run(h.cmdReviews)
	if code != ExitOK || !strings.Contains(out, `"state": "open"`) {
		t.Errorf("reviews output: %s", out)
	}

	// Default resolution now finds the single open review.
	code, out = h.run(h.cmdFeedback)
	if code != ExitOK {
		t.Errorf("feedback default resolution failed: %d %s", code, out)
	}
	if !strings.Contains(out, fmt.Sprintf(`"id": %d`, id)) {
		t.Errorf("resolved wrong review: %s", out)
	}
}

func TestURLPrintsPublicAuthURL(t *testing.T) {
	h := newHarness(t)
	h.publicURL = "http://agent1.localhost:3191"
	token := h.client.Token

	code, out := h.run(h.cmdURL)
	if code != ExitOK {
		t.Fatalf("url with no review: exit %d: %s", code, out)
	}
	if want := "http://agent1.localhost:3191/auth?token=" + token + "&next=%2F\n"; out != want {
		t.Errorf("url with no review = %q, want %q", out, want)
	}

	id, _ := h.openReview()
	code, out = h.run(h.cmdURL)
	if code != ExitOK {
		t.Fatalf("url: exit %d: %s", code, out)
	}
	if want := fmt.Sprintf("http://agent1.localhost:3191/auth?token=%s&next=%%2Freviews%%2F%d\n", token, id); out != want {
		t.Errorf("url = %q, want %q", out, want)
	}

	code, out = h.run(h.cmdURL, "--review", "42")
	if code != ExitOK {
		t.Fatalf("url --review: exit %d: %s", code, out)
	}
	if !strings.HasSuffix(out, "&next=%2Freviews%2F42\n") {
		t.Errorf("url --review 42 = %q", out)
	}
}

func TestOpenReportsPublicURL(t *testing.T) {
	h := newHarness(t)
	h.publicURL = "http://agent1.localhost:3191"
	h.modify("package main\n\nfunc main() {\n\tprintln(\"v2\")\n}\n")
	var opened string
	h.openURL = func(u string) error { opened = u; return nil }
	code, out := h.run(h.cmdOpen)
	if code != ExitOK {
		t.Fatalf("open: exit %d: %s", code, out)
	}
	var parsed struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(parsed.URL, "http://agent1.localhost:3191/auth?token=") {
		t.Errorf("open url = %q, want the public base", parsed.URL)
	}
	if opened != parsed.URL {
		t.Errorf("browser opened %q, printed %q", opened, parsed.URL)
	}
}

func TestOpenReuseAddsRoundInsteadOfNewReview(t *testing.T) {
	h := newHarness(t)
	id, _ := h.openReview()

	h.modify("package main\n\nfunc main() {\n\tprintln(\"v3\")\n}\n")
	code, out := h.run(h.cmdOpen, "--no-browser", "--reuse")
	if code != ExitOK {
		t.Fatalf("open --reuse: exit %d: %s", code, out)
	}
	var reused struct {
		Reused bool `json:"reused"`
		Review struct {
			ID int64 `json:"id"`
		} `json:"review"`
		Round struct {
			Seq int `json:"seq"`
		} `json:"round"`
		Cursor int64  `json:"cursor"`
		URL    string `json:"url"`
	}
	if err := json.Unmarshal([]byte(out), &reused); err != nil {
		t.Fatal(err)
	}
	if !reused.Reused || reused.Review.ID != id || reused.Round.Seq != 2 || reused.Cursor == 0 {
		t.Errorf("reuse = %+v, want review %d round 2 with a cursor", reused, id)
	}
	if !strings.Contains(reused.URL, "&next=") {
		t.Errorf("url = %q, want a plain & (no HTML escaping)", reused.URL)
	}

	code, out = h.run(h.cmdOpen, "--no-browser", "--reuse")
	if code != ExitOK || !strings.Contains(out, `"notice"`) || strings.Contains(out, `"cursor"`) {
		t.Errorf("unchanged diff: exit %d, want a dedupe notice and no cursor: %s", code, out)
	}

	code, out = h.run(h.cmdReviews)
	if code != ExitOK || strings.Count(out, `"sourceArgs"`) != 1 {
		t.Errorf("reuse created extra reviews: %s", out)
	}

	code, out = h.run(h.cmdOpen, "--no-browser")
	if code != ExitOK || strings.Contains(out, `"reused"`) {
		t.Errorf("open without --reuse should create a review: exit %d: %s", code, out)
	}
	_, out = h.run(h.cmdReviews)
	if strings.Count(out, `"sourceArgs"`) != 2 {
		t.Errorf("want two reviews after a plain open: %s", out)
	}
}

func TestOpenKeepsPathspecSeparator(t *testing.T) {
	h := newHarness(t)
	h.modify("package main\n\nfunc main() {\n\tprintln(\"v2\")\n}\n")
	if err := os.MkdirAll(filepath.Join(h.repo, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, h.repo, "notes/todo.txt", "untracked, in scope\n")
	writeFile(t, h.repo, "stray.txt", "untracked, out of scope\n")

	code, out := h.run(h.cmdOpen, "--no-browser", "--", "notes", "main.go")
	if code != ExitOK {
		t.Fatalf("open -- notes main.go: exit %d: %s", code, out)
	}
	var created struct {
		Review struct {
			ID         int64    `json:"id"`
			SourceArgs []string `json:"sourceArgs"`
		} `json:"review"`
	}
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		t.Fatal(err)
	}
	if want := []string{"--", "notes", "main.go"}; !slices.Equal(created.Review.SourceArgs, want) {
		t.Errorf("sourceArgs = %q, want %q", created.Review.SourceArgs, want)
	}

	// The separator keeps this a working-tree capture, so untracked
	// files inside the pathspec are in and everything outside is out.
	var round struct {
		Files []struct {
			Path string `json:"path"`
		} `json:"files"`
	}
	if err := h.client.do("GET", fmt.Sprintf("/api/reviews/%d/rounds/1", created.Review.ID), nil, &round); err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range round.Files {
		paths = append(paths, f.Path)
	}
	slices.Sort(paths)
	if want := []string{"main.go", "notes/todo.txt"}; !slices.Equal(paths, want) {
		t.Errorf("round files = %q, want %q", paths, want)
	}

	code, out = h.run(h.cmdOpen, "--no-browser", "--reuse", "--", "notes", "main.go")
	if code != ExitOK || !strings.Contains(out, `"reused": true`) {
		t.Errorf("open --reuse with the same pathspec: exit %d: %s", code, out)
	}
}

func TestExportPrintsMarkdown(t *testing.T) {
	h := newHarness(t)
	id, _ := h.openReview()
	h.reviewerDraft(id, 4, "prefer fmt.Println here")
	h.reviewerSubmit(id, "comment", "")

	code, out := h.run(h.cmdExport)
	if code != ExitOK {
		t.Fatalf("export: exit %d: %s", code, out)
	}
	if !strings.HasPrefix(out, "# Review #") || !strings.Contains(out, "prefer fmt.Println here") {
		t.Errorf("export output is not the review markdown:\n%s", out)
	}
}
