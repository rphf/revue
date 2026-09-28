package server

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/rphf/revue/internal/gittest"
)

func (ts *testServer) note(t *testing.T) *noteView {
	t.Helper()
	var out struct {
		Note *noteView `json:"note"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/note", nil, &out), http.StatusOK)
	return out.Note
}

func TestTheAgentNoteIsReplacedAndOutdatedByNewCode(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	if n := ts.note(t); n != nil {
		t.Fatalf("before any note: %+v", n)
	}
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "first"}, nil), http.StatusOK)
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "## Checked\n- tests pass"}, nil), http.StatusOK)
	if n := ts.note(t); n == nil || n.Body != "## Checked\n- tests pass" || n.Outdated || n.UpdatedAt.IsZero() {
		t.Fatalf("note = %+v", n)
	}

	ts.modify(t)
	if n := ts.note(t); n == nil || !n.Outdated {
		t.Fatalf("note after a code change = %+v, want outdated", n)
	}
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "rewritten"}, nil), http.StatusOK)
	if n := ts.note(t); n == nil || n.Outdated {
		t.Fatalf("a rewritten note = %+v, want current", n)
	}

	var out apiError
	if resp := ts.do(t, "PUT", "/api/note", map[string]any{"body": "  "}, &out); resp.StatusCode != http.StatusBadRequest || out.Error != "validation" {
		t.Errorf("empty note: %d %+v", resp.StatusCode, out)
	}
	ts.mustStatus(t, ts.do(t, "DELETE", "/api/note", nil, nil), http.StatusNoContent)
	if n := ts.note(t); n != nil {
		t.Errorf("note after clear = %+v", n)
	}
	ts.mustStatus(t, ts.do(t, "DELETE", "/api/note", nil, nil), http.StatusNoContent)
}

func TestTheAgentNoteBelongsToItsBranch(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "on main"}, nil), http.StatusOK)
	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "side")
	if n := ts.note(t); n != nil {
		t.Fatalf("side branch shows %+v", n)
	}
	gittest.Git(t, ts.repo, "checkout", "-q", "main")
	if n := ts.note(t); n == nil || n.Body != "on main" {
		t.Fatalf("main note = %+v", n)
	}
}

// A write or a clear is an event, so the page picks it up live; a clear
// with no note is not.
func TestNoteChangesAreEvents(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "hello"}, nil), http.StatusOK)
	ts.mustStatus(t, ts.do(t, "DELETE", "/api/note", nil, nil), http.StatusNoContent)
	ts.mustStatus(t, ts.do(t, "DELETE", "/api/note", nil, nil), http.StatusNoContent)
	fb := ts.feedback(t, 0)
	n := 0
	for _, e := range fb.Events {
		if e.Type == eventNoteChanged {
			n++
		}
	}
	if n != 2 {
		t.Errorf("note events = %d, want 2", n)
	}
}

func TestExportStartsWithTheAgentNote(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "what changed\n"}, nil), http.StatusOK)
	resp := ts.do(t, "GET", "/api/export", nil, nil)
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "## Agent note\n\nwhat changed\n") {
		t.Errorf("export:\n%s", data)
	}
}

// A note is one round's handoff: once HEAD moves past the commit it was
// written on, it is done, like threads that land.
func TestTheAgentNoteEndsWhenHEADMoves(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "before the commit"}, nil), http.StatusOK)
	gittest.Git(t, ts.repo, "add", "-A")
	gittest.Git(t, ts.repo, "commit", "-q", "-m", "the round's work")
	if n := ts.note(t); n != nil {
		t.Fatalf("note after a commit = %+v", n)
	}
	ts.mustStatus(t, ts.do(t, "PUT", "/api/note", map[string]any{"body": "after the commit"}, nil), http.StatusOK)
	if n := ts.note(t); n == nil || n.Body != "after the commit" {
		t.Fatalf("note written after the commit = %+v", n)
	}
}
