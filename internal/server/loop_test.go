package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/rphf/revue/internal/gittest"
	"github.com/rphf/revue/internal/gitx"
	"github.com/rphf/revue/internal/store"
)

func TestAgentThreadIsPublishedAndEvented(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	cursor := ts.feedback(t, 0).Cursor

	var out struct {
		Thread  *store.Thread  `json:"thread"`
		Comment *store.Comment `json:"comment"`
		Cursor  int64          `json:"cursor"`
	}
	resp := ts.do(t, "POST", "/api/threads", map[string]any{
		"role": "agent", "args": []string{}, "path": "a.txt", "side": "additions",
		"line": 15, "body": "this is why",
	}, &out)
	ts.mustStatus(t, resp, http.StatusCreated)
	if out.Comment.Draft || out.Comment.AuthorRole != store.RoleAgent || out.Cursor <= cursor {
		t.Errorf("agent thread = %+v, cursor %d", out.Comment, out.Cursor)
	}
	if a := ts.anchorOf(t, out.Thread.ID); a.State != "live" || a.Line != 15 {
		t.Errorf("agent thread anchor = %+v, want live on 15", a)
	}

	fb := ts.feedback(t, cursor)
	if len(fb.Events) != 1 || fb.Events[0].Type != eventOpened {
		t.Errorf("events = %+v, want one %s", fb.Events, eventOpened)
	}

	// The reviewer's thread is still a draft by default.
	id := ts.draft(t, 15, "a draft")
	var threads struct {
		Threads []*threadView `json:"threads"`
	}
	ts.do(t, "GET", "/api/threads", nil, &threads)
	for _, th := range threads.Threads {
		if th.ID == id && !th.Comments[0].Draft {
			t.Errorf("reviewer thread published: %+v", th.Comments[0])
		}
	}
}

func TestCreateThreadRejectsAnUnknownRole(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	resp := ts.do(t, "POST", "/api/threads", map[string]any{
		"role": "robot", "args": []string{}, "path": "a.txt", "side": "additions",
		"line": 15, "body": "x",
	}, nil)
	ts.mustStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()
}

func TestSendCheckpointsTheWorkingTreeForTheDiffSinceTheLastSend(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)

	resp := ts.do(t, "GET", "/api/diff"+argsQuery(gitx.LastSendRef), nil, nil)
	ts.mustStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()

	ts.draft(t, 15, "rename it")
	writeFile(t, ts.repo, "notes.txt", "untracked at the send\n")
	status := gittest.Git(t, ts.repo, "status", "--porcelain")
	ts.send(t, "")
	if got := gittest.Git(t, ts.repo, "status", "--porcelain"); got != status {
		t.Errorf("the send changed the status:\n%s\nwant:\n%s", got, status)
	}

	if d := ts.getDiff(t, gitx.LastSendRef); len(d.Files) != 0 {
		t.Errorf("diff right after the send = %+v, want empty", d.Files)
	}

	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{15: changedLine, 2: "line 2 EDITED"}))
	d := ts.getDiff(t, gitx.LastSendRef)
	if len(d.Files) != 1 || d.Files[0].Path != "a.txt" {
		t.Fatalf("files since the send = %+v, want a.txt only", d.Files)
	}
	if !strings.Contains(d.Patch, "+line 2 EDITED") || strings.Contains(d.Patch, "+"+changedLine) {
		t.Errorf("patch is not the change since the send:\n%s", d.Patch)
	}
}

func TestSnapshotCarriesTheFileAsItIsNow(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.draft(t, 15, "remember this")
	now := fixtureContent(map[int]string{15: "line 15 AGAIN"})
	writeFile(t, ts.repo, "a.txt", now)

	var snap struct {
		NewContent     string  `json:"newContent"`
		CurrentContent *string `json:"currentContent"`
	}
	resp := ts.do(t, "GET", fmt.Sprintf("/api/threads/%d/snapshot", id), nil, &snap)
	ts.mustStatus(t, resp, http.StatusOK)
	if snap.CurrentContent == nil || *snap.CurrentContent != now {
		t.Errorf("currentContent = %v, want the working tree", snap.CurrentContent)
	}
	if snap.NewContent == now {
		t.Error("newContent followed the working tree")
	}
}
