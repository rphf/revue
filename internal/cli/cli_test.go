package cli

import (
	"bytes"
	"context"
	"encoding/json"
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

type feedback struct {
	Cursor int64 `json:"cursor"`
	Events []struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"events"`
	Threads []struct {
		ID       int64  `json:"id"`
		Path     string `json:"path"`
		Line     int    `json:"line"`
		Comments []struct {
			AuthorRole string `json:"authorRole"`
			Body       string `json:"body"`
			Draft      bool   `json:"draft"`
		} `json:"comments"`
		Quote *struct {
			Path  string   `json:"path"`
			Lines []string `json:"lines"`
		} `json:"quote"`
	} `json:"threads"`
	LastSend *struct {
		Note string `json:"note"`
	} `json:"lastSend"`
}

func (h *harness) feedback(since int64) feedback {
	h.t.Helper()
	code, out := h.run(h.cmdFeedback, "--since", fmt.Sprint(since))
	if code != ExitOK {
		h.t.Fatalf("feedback failed (%d): %s", code, out)
	}
	var fb feedback
	if err := json.Unmarshal([]byte(out), &fb); err != nil {
		h.t.Fatalf("feedback output not JSON: %v\n%s", err, out)
	}
	return fb
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

func TestFeedbackShowsSentThreadsWithQuotedCode(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	h.reviewerDraft(4, "use fmt.Println")

	// Drafts are invisible until sent.
	fb := h.feedback(0)
	if len(fb.Threads) != 0 || fb.LastSend != nil || fb.Cursor != 0 {
		t.Fatalf("draft leaked: %+v", fb)
	}

	h.reviewerSend("one fix, then commit")
	fb = h.feedback(0)
	if len(fb.Threads) != 1 {
		t.Fatalf("threads = %d, want 1", len(fb.Threads))
	}
	th := fb.Threads[0]
	if th.Path != "main.go" || th.Line != 4 || th.Quote == nil || strings.Join(th.Quote.Lines, "\n") != "\tprintln(\"v2\")" {
		t.Errorf("thread = %+v", th)
	}
	if len(th.Comments) != 1 || th.Comments[0].Body != "use fmt.Println" || th.Comments[0].Draft {
		t.Errorf("comments = %+v", th.Comments)
	}
	if fb.LastSend == nil || fb.LastSend.Note != "one fix, then commit" {
		t.Errorf("lastSend = %+v", fb.LastSend)
	}
	if len(fb.Events) != 1 || fb.Events[0].Type != "sent" || fb.Cursor != fb.Events[0].ID {
		t.Errorf("events = %+v, cursor %d", fb.Events, fb.Cursor)
	}
}

func TestSinceReturnsOnlyNewItemsAcrossReads(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "first")
	h.reviewerSend("")
	cursor := h.feedback(0).Cursor

	code, _ := h.run(h.cmdReply, "--thread", fmt.Sprint(id), "-m", "done")
	if code != ExitOK {
		t.Fatal("reply failed")
	}
	h.reviewerDraft(1, "second")
	h.reviewerSend("more")

	fb := h.feedback(cursor)
	types := []string{}
	for _, e := range fb.Events {
		types = append(types, e.Type)
	}
	if strings.Join(types, ",") != "thread.replied,sent" {
		t.Errorf("events since %d = %v", cursor, types)
	}
	if len(fb.Threads) != 2 {
		t.Errorf("threads = %d, want both unresolved threads", len(fb.Threads))
	}
	if again := h.feedback(fb.Cursor); len(again.Events) != 0 || again.Cursor != fb.Cursor {
		t.Errorf("nothing new, got %+v", again)
	}
}

func TestWaitReturnsOnSendAndTimesOutDistinctly(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	h.reviewerDraft(4, "pending")

	code, out := h.run(h.cmdWait, "--timeout", "150ms")
	if code != ExitWaitTimeout || !strings.Contains(out, `"outcome": "timeout"`) {
		t.Errorf("timeout: exit %d, out %s", code, out)
	}

	go func() {
		time.Sleep(100 * time.Millisecond)
		h.reviewerSend("go ahead")
	}()
	code, out = h.run(h.cmdWait, "--timeout", "5s")
	if code != ExitOK || !strings.Contains(out, `"outcome": "sent"`) || !strings.Contains(out, `"note": "go ahead"`) {
		t.Errorf("sent: exit %d, out %s", code, out)
	}

	code, _ = h.run(h.cmdWait, "--timeout", "0")
	if code != ExitValidation {
		t.Errorf("zero timeout: exit %d, want %d", code, ExitValidation)
	}
}

func TestReplyPostsAgentCommentAndMapsErrors(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "question")
	h.reviewerSend("")

	code, out := h.run(h.cmdReply, "--thread", fmt.Sprint(id), "-m", "answer")
	if code != ExitOK {
		t.Fatalf("reply: exit %d: %s", code, out)
	}
	var parsed struct {
		Comment struct {
			AuthorRole string `json:"authorRole"`
			Body       string `json:"body"`
			Draft      bool   `json:"draft"`
		} `json:"comment"`
		Cursor int64 `json:"cursor"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Comment.AuthorRole != "agent" || parsed.Comment.Body != "answer" || parsed.Comment.Draft || parsed.Cursor == 0 {
		t.Errorf("reply output = %+v", parsed)
	}
	if fb := h.feedback(0); len(fb.Threads[0].Comments) != 2 || fb.Threads[0].Comments[1].AuthorRole != "agent" {
		t.Errorf("reply not in feedback: %+v", fb.Threads[0].Comments)
	}

	code, out = h.run(h.cmdReply, "-m", "no thread")
	if code != ExitValidation || !strings.Contains(out, `"validation"`) {
		t.Errorf("missing --thread: exit %d, out %s", code, out)
	}
	code, out = h.run(h.cmdReply, "--thread", "999", "-m", "ghost")
	if code != ExitValidation || !strings.Contains(out, `"not_found"`) {
		t.Errorf("unknown thread: exit %d, out %s", code, out)
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
