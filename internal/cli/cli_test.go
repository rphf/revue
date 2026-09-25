package cli

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rphf/revue/internal/gittest"
	"github.com/rphf/revue/internal/server"
)

// --- fixtures ---

func initRepo(t *testing.T) string {
	t.Helper()
	dir := gittest.Init(t)
	writeFile(t, dir, "main.go", "package main\n\nfunc main() {\n\tprintln(\"v1\")\n}\n")
	gittest.Git(t, dir, "add", "-A")
	gittest.Git(t, dir, "commit", "-q", "-m", "c1")
	return dir
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
	opened []string
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
	h := &harness{t: t, repo: repo, srv: srv, out: out, errOut: errOut}
	h.env = &env{
		client:   &Client{BaseURL: srv.URL(), Token: srv.Token(), HTTP: &http.Client{}},
		state:    &server.State{Token: srv.Token(), PublicURL: srv.PublicURL()},
		repoRoot: repo,
		stdout:   out,
		stderr:   errOut,
		openURL: func(u string) error {
			h.opened = append(h.opened, u)
			return nil
		},
	}
	return h
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

const v2 = "package main\n\nfunc main() {\n\tprintln(\"v2\")\n}\n"

// reviewerDraft creates a reviewer draft thread through the HTTP API
// (the reviewer normally acts through the browser).
func (h *harness) reviewerDraft(line int, body string) int64 {
	h.t.Helper()
	var out struct {
		Thread struct {
			ID int64 `json:"id"`
		} `json:"thread"`
	}
	if err := h.client.do("POST", "/api/threads", map[string]any{
		"args": []string{}, "path": "main.go", "side": "additions", "line": line, "body": body,
	}, &out); err != nil {
		h.t.Fatalf("draft: %v", err)
	}
	return out.Thread.ID
}

func (h *harness) reviewerSend(note string) {
	h.t.Helper()
	if err := h.client.do("POST", "/api/send", map[string]any{"note": note}, nil); err != nil {
		h.t.Fatalf("send: %v", err)
	}
}

// feedback runs feedback, with --since unless since is 0, and returns
// its text.
func (h *harness) feedback(since int64) string {
	h.t.Helper()
	args := []string{}
	if since != 0 {
		args = []string{"--since", fmt.Sprint(since)}
	}
	code, out := h.run(h.cmdFeedback, args...)
	if code != ExitOK {
		h.t.Fatalf("feedback failed (%d): %s", code, h.errOut.String())
	}
	return out
}

// cursorOf reads the cursor off the first line of feedback or wait.
func cursorOf(t *testing.T, out string) int64 {
	t.Helper()
	var c int64
	if _, err := fmt.Sscanf(out, "cursor %d\n", &c); err != nil {
		t.Fatalf("no cursor line in %q", out)
	}
	return c
}

// resolve resolves a thread the way the reviewer's page does.
func (h *harness) resolve(id int64) {
	h.t.Helper()
	if err := h.client.do("POST", fmt.Sprintf("/api/threads/%d/resolve", id), map[string]any{}, nil); err != nil {
		h.t.Fatalf("resolve: %v", err)
	}
}

// --- tests ---

func TestOpenPrintsALoginLinkForTheDiff(t *testing.T) {
	h := newHarness(t)

	// A clean tree is not an error: the page shows "No changes".
	code, out := h.run(h.cmdOpen, "--no-browser")
	if code != ExitOK {
		t.Fatalf("open on a clean tree: exit %d, stderr %q", code, h.errOut.String())
	}
	link := strings.TrimSpace(out)
	if !strings.HasPrefix(link, h.srv.PublicURL()+"/auth?token="+h.srv.Token()+"&next=%2F") || strings.Contains(link, "arg") {
		t.Errorf("default link = %q", link)
	}
	if len(h.opened) != 0 {
		t.Errorf("--no-browser opened %v", h.opened)
	}

	// Arguments end up in the page URL, one query parameter each; the
	// pathspec separator survives the flag parser.
	h.modify(v2)
	code, out = h.run(h.cmdOpen, "--", "main.go")
	if code != ExitOK {
		t.Fatalf("open -- main.go: exit %d, stderr %q", code, h.errOut.String())
	}
	link = strings.TrimSpace(out)
	if !strings.HasSuffix(link, "&next=%2F%3Farg%3D--%26arg%3Dmain.go") {
		t.Errorf("pathspec link = %q", link)
	}
	if len(h.opened) != 1 || h.opened[0] != link {
		t.Errorf("browser opened with %v, want %q", h.opened, link)
	}
}

func TestOpenFocusesAPageAlreadyOnTheDiff(t *testing.T) {
	h := newHarness(t)
	req, _ := http.NewRequest("GET", h.srv.URL()+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+h.srv.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	// The first frame means the stream is registered with the server.
	if _, err := bufio.NewReader(resp.Body).ReadString('\n'); err != nil {
		t.Fatal(err)
	}

	if code, _ := h.run(h.cmdOpen); code != ExitOK {
		t.Fatalf("open: exit %d, stderr %q", code, h.errOut.String())
	}
	if len(h.opened) != 0 {
		t.Errorf("open with a page on the diff opened %v, want no new tab", h.opened)
	}
	if !strings.Contains(h.errOut.String(), "already open") {
		t.Errorf("stderr = %q, want a note that the page is already open", h.errOut.String())
	}

	// Another diff has no page, so it gets a tab.
	h.modify(v2)
	if code, _ := h.run(h.cmdOpen, "--", "main.go"); code != ExitOK {
		t.Fatalf("open -- main.go: exit %d", code)
	}
	if len(h.opened) != 1 {
		t.Errorf("open on another diff opened %v, want one tab", h.opened)
	}
}

func TestOpenRejectsBadArgumentsInTheTerminal(t *testing.T) {
	h := newHarness(t)
	for _, args := range [][]string{{"--no-browser", "--ext-diff"}, {"--no-browser", "nosuchref"}} {
		code, out := h.run(h.cmdOpen, args...)
		if code != ExitValidation {
			t.Errorf("open %v: exit %d, want %d", args, code, ExitValidation)
		}
		if out != "" || h.errOut.Len() == 0 {
			t.Errorf("open %v: stdout %q, stderr %q; want the reason on stderr only", args, out, h.errOut.String())
		}
	}
}

func TestURLPrintsTheDefaultLoginLink(t *testing.T) {
	h := newHarness(t)
	code, out := h.run(h.cmdURL)
	if code != ExitOK {
		t.Fatal("url failed")
	}
	if want := h.srv.PublicURL() + "/auth?token=" + h.srv.Token() + "&next=%2F"; strings.TrimSpace(out) != want {
		t.Errorf("url = %q, want %q", out, want)
	}
}

func TestFeedbackPrintsThreadsWithQuotedCode(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "use fmt.Println\nand a newline")

	// Drafts are invisible until sent.
	if out := h.feedback(0); out != "cursor 0\n" {
		t.Fatalf("draft leaked: %q", out)
	}

	h.reviewerSend("one fix, then commit")
	out := h.feedback(0)
	want := fmt.Sprintf("cursor %d\nnote: one fix, then commit\n\n#%d main.go:4\n  | \tprintln(\"v2\")\nreviewer: use fmt.Println\n  and a newline\n", cursorOf(t, out), id)
	if out != want {
		t.Errorf("feedback =\n%s\nwant\n%s", out, want)
	}
}

func TestSinceReturnsOnlyWhatTheReviewerDidAfterTheCursor(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	first := h.reviewerDraft(4, "first")
	h.reviewerSend("")
	cursor := cursorOf(t, h.feedback(0))

	if code, _ := h.run(h.cmdReply, fmt.Sprint(first), "done"); code != ExitOK {
		t.Fatalf("reply failed: %s", h.errOut.String())
	}
	second := h.reviewerDraft(1, "second")
	h.reviewerSend("more")
	h.resolve(first)

	out := h.feedback(cursor)
	want := fmt.Sprintf("cursor %d\nnote: more\n\n#%d main.go:1\n  | package main\nreviewer: second\n\nresolved: %d\n", cursorOf(t, out), second, first)
	if out != want {
		t.Errorf("feedback --since =\n%s\nwant\n%s", out, want)
	}
	next := cursorOf(t, out)
	if again := h.feedback(next); again != fmt.Sprintf("cursor %d\n", next) {
		t.Errorf("nothing new, got %q", again)
	}
}

func TestFeedbackMarksOutdatedThreads(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "rename")
	h.reviewerSend("")
	h.modify("package main\n\nfunc main() {\n\tprintln(\"v3\")\n}\n")
	// The server re-reads the diff at most every half second.
	want := fmt.Sprintf("#%d main.go:4 outdated\n", id)
	for deadline := time.Now().Add(3 * time.Second); ; {
		if out := h.feedback(0); strings.Contains(out, want) {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("feedback without %q: %s", want, out)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestWaitPrintsTheSendAndTimesOutDistinctly(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "pending")

	code, out := h.run(h.cmdWait, "--timeout", "150ms")
	if code != ExitWaitTimeout || out != "cursor 0\ntimeout\n" {
		t.Errorf("timeout: exit %d, out %q", code, out)
	}

	go func() {
		time.Sleep(100 * time.Millisecond)
		h.reviewerSend("go ahead")
	}()
	code, out = h.run(h.cmdWait, "--timeout", "5s")
	if code != ExitOK || !strings.Contains(out, "note: go ahead\n") ||
		!strings.Contains(out, fmt.Sprintf("#%d main.go:4\n", id)) || !strings.Contains(out, "reviewer: pending\n") {
		t.Errorf("sent: exit %d, out %s", code, out)
	}

	if code, _ = h.run(h.cmdWait, "--timeout", "0"); code != ExitValidation {
		t.Errorf("zero timeout: exit %d, want %d", code, ExitValidation)
	}
}

// The incident: an agent passed the thread id that comment printed as a
// cursor, the wait replayed the previous session's approval, and the
// agent committed code nobody reviewed.
func TestAThreadIDAsCursorNeverReplaysAnOldApproval(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	// The previous session's rounds put the delivered cursor past the id
	// of the next thread.
	h.reviewerSend("first round")
	h.reviewerSend("second round")
	h.reviewerSend("LGTM, commit and push")
	if code, out := h.run(h.cmdWait, "--timeout", "1s"); code != ExitOK || !strings.Contains(out, "note: LGTM") {
		t.Fatalf("first wait: exit %d, out %q", code, out)
	}

	code, out := h.run(h.cmdComment, "main.go:4", "a self-review note")
	if code != ExitOK {
		t.Fatalf("comment: exit %d, %s", code, h.errOut.String())
	}
	id := strings.TrimSpace(out)
	code, out = h.run(h.cmdWait, "--since", id, "--timeout", "200ms")
	if code != ExitValidation || strings.Contains(out, "LGTM") || h.errOut.Len() == 0 {
		t.Errorf("wait --since %s: exit %d, out %q, stderr %q", id, code, out, h.errOut.String())
	}
	code, out = h.run(h.cmdWait, "--timeout", "200ms")
	if code != ExitWaitTimeout || strings.Contains(out, "LGTM") {
		t.Errorf("bare wait: exit %d, out %q", code, out)
	}
}

func TestFeedbackPrintsEveryUndeliveredNoteAndMarksStaleOnes(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	h.reviewerSend("first look")
	h.reviewerSend("LGTM")
	writeFile(t, h.repo, "later.go", "package main\n")

	out := h.feedback(0)
	stale := "stale: the code changed after this send; its note does not approve the current diff\n"
	want := fmt.Sprintf("cursor %d\nnote: first look\n%snote: LGTM\n%s", cursorOf(t, out), stale, stale)
	if out != want {
		t.Errorf("feedback =\n%s\nwant\n%s", out, want)
	}
	if again := h.feedback(0); strings.Contains(again, "note:") {
		t.Errorf("notes delivered twice: %q", again)
	}
}

func TestReplyPostsQuietlyAndReportsErrorsOnStderr(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "question")
	h.reviewerSend("")

	code, out := h.run(h.cmdReply, fmt.Sprint(id), "the", "answer")
	if code != ExitOK || out != "" {
		t.Fatalf("reply: exit %d, out %q, stderr %s", code, out, h.errOut.String())
	}
	if fb := h.feedback(0); !strings.HasSuffix(fb, "reviewer: question\nagent: the answer\n") {
		t.Errorf("reply not in feedback: %s", fb)
	}

	code, out = h.run(h.cmdReply)
	if code != ExitValidation || out != "" || !strings.HasPrefix(h.errOut.String(), "revue: usage: revue reply") {
		t.Errorf("no id: exit %d, out %q, stderr %q", code, out, h.errOut.String())
	}
	code, _ = h.run(h.cmdReply, "999", "ghost")
	if code != ExitValidation || !strings.HasPrefix(h.errOut.String(), "revue: ") || strings.Count(h.errOut.String(), "\n") != 1 {
		t.Errorf("unknown thread: exit %d, stderr %q", code, h.errOut.String())
	}
}

func TestCommentOpensAnAgentThreadAndPrintsItsID(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)

	code, out := h.run(h.cmdComment, "main.go:3-4", "why", "v2")
	if code != ExitOK {
		t.Fatalf("comment: exit %d: %s", code, h.errOut.String())
	}
	id := strings.TrimSpace(out)
	if fb := h.feedback(0); !strings.Contains(fb, "#"+id+" main.go:3-4\n  | func main() {\n  | \tprintln(\"v2\")\nagent: why v2\n") {
		t.Errorf("agent thread not in feedback: %s", fb)
	}

	if code, out = h.run(h.cmdComment, "main.go", "whole file"); code != ExitOK {
		t.Errorf("file comment: exit %d, stderr %s", code, h.errOut.String())
	} else if fb := h.feedback(0); !strings.Contains(fb, "#"+strings.TrimSpace(out)+" main.go\nagent: whole file\n") {
		t.Errorf("file comment not in feedback: %s", fb)
	}
	if code, out = h.run(h.cmdComment, "main.go:4", "--old", "old side", "--", "HEAD"); code != ExitOK {
		t.Errorf("old side in a HEAD diff: exit %d, stderr %s", code, h.errOut.String())
	} else if fb := h.feedback(0); !strings.Contains(fb, "#"+strings.TrimSpace(out)+" main.go:4 old\n  | \tprintln(\"v1\")\n") {
		t.Errorf("old-side comment not in feedback: %s", fb)
	}

	for _, args := range [][]string{{}, {"main.go:4-2", "bad range"}, {"main.go:4", "--side", "x"}} {
		if code, _ := h.run(h.cmdComment, args...); code != ExitValidation {
			t.Errorf("comment %v: exit %d, want %d", args, code, ExitValidation)
		}
	}
	if code, _ := h.run(h.cmdComment, "gone.go:1", "not in the diff"); code != ExitValidation {
		t.Errorf("file not in the diff: exit %d, stderr %s", code, h.errOut.String())
	}
}

func TestExportPrintsMarkdown(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	h.reviewerDraft(4, "sent comment")
	h.reviewerSend("")
	h.reviewerDraft(1, "unsent draft")

	code, out := h.run(h.cmdExport)
	if code != ExitOK {
		t.Fatalf("export: exit %d: %s", code, out)
	}
	for _, want := range []string{"# Threads in ", "## main.go", "`main.go:4` (additions", "println(\"v2\")", "sent comment"} {
		if !strings.Contains(out, want) {
			t.Errorf("export missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "unsent draft") {
		t.Errorf("draft leaked into export:\n%s", out)
	}
}

// Help and version answer anywhere, not only inside a repository: their
// flag forms must not fall through to `revue open`.
func TestHelpAndVersionWorkOutsideARepo(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, args := range [][]string{{"--version"}, {"version"}, {"-h"}, {"--help"}, {"help"}} {
		if code := Main(args); code != ExitOK {
			t.Errorf("revue %v exited %d, want %d", args, code, ExitOK)
		}
	}
}
