package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func sentNotes(fb *feedback) []string {
	var notes []string
	for _, e := range fb.Events {
		if e.Type == eventSent {
			notes = append(notes, string(e.Payload))
		}
	}
	return notes
}

func TestFeedbackDeliversEachSendOnce(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.send(t, "LGTM, commit and push")
	if n := sentNotes(ts.feedback(t, 0)); len(n) != 1 || !strings.Contains(n[0], "LGTM") {
		t.Fatalf("first feedback = %v", n)
	}
	if n := sentNotes(ts.feedback(t, 0)); len(n) != 0 {
		t.Fatalf("second feedback replayed %v", n)
	}
}

// The incident this guards against: an old approval printed again as if
// the reviewer had just sent it.
func TestWaitWithoutSinceNeverReplaysADeliveredSend(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.send(t, "LGTM, commit and push")
	ts.feedback(t, 0)

	var out waitOutcome
	ts.mustStatus(t, ts.do(t, "GET", "/api/wait?timeout=200ms", nil, &out), http.StatusOK)
	if out.Outcome != "timeout" {
		t.Fatalf("wait after delivery = %+v, want timeout", out)
	}
}

func TestWaitDeliversASendMadeWhileNobodyWaited(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	sd := ts.send(t, "done reviewing")

	var out waitOutcome
	ts.mustStatus(t, ts.do(t, "GET", "/api/wait?timeout=1s", nil, &out), http.StatusOK)
	if out.Outcome != "sent" || out.Send == nil || out.Send.ID != sd.ID {
		t.Fatalf("wait = %+v, want send %d", out, sd.ID)
	}
}

func TestCursorsOlderThanDeliveredOrNeverIssuedAreRefused(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.send(t, "one")
	ts.send(t, "two")
	cursor := ts.feedback(t, 0).Cursor

	for _, path := range []string{
		fmt.Sprintf("/api/wait?since=%d&timeout=100ms", cursor-1),
		fmt.Sprintf("/api/feedback?since=%d", cursor-1),
		fmt.Sprintf("/api/wait?since=%d&timeout=100ms", cursor+1),
		fmt.Sprintf("/api/feedback?since=%d", cursor+1),
	} {
		var out apiError
		resp := ts.do(t, "GET", path, nil, &out)
		if resp.StatusCode != http.StatusBadRequest || out.Error != "validation" {
			t.Errorf("%s: %d %+v, want a validation error", path, resp.StatusCode, out)
		}
	}
	var out waitOutcome
	ts.mustStatus(t, ts.do(t, "GET", fmt.Sprintf("/api/wait?since=%d&timeout=100ms", cursor), nil, &out), http.StatusOK)
	if out.Outcome != "timeout" {
		t.Errorf("wait from the delivered cursor = %+v", out)
	}
}

// A database from before the delivery cursor starts at its newest event,
// so its old sends do not replay.
func TestADatabaseWithoutADeliveryCursorStartsAtItsNewestEvent(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.send(t, "old approval")
	db, err := sql.Open("sqlite", "file:"+filepath.Join(ts.dataDir, "revue.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("DELETE FROM settings WHERE key = ?", settingDelivered); err != nil {
		t.Fatal(err)
	}
	if err := ts.seedDelivered(); err != nil {
		t.Fatal(err)
	}
	if n := sentNotes(ts.feedback(t, 0)); len(n) != 0 {
		t.Fatalf("old sends replayed after the seed: %v", n)
	}
}

// A wait that timed out leaves the send for later, on whichever server
// serves the repository then.
func TestAnUndeliveredSendOutlastsTheServer(t *testing.T) {
	repo := initRepo(t)
	ts := startServer(t, repo, 0)
	var out waitOutcome
	ts.mustStatus(t, ts.do(t, "GET", "/api/wait?timeout=100ms", nil, &out), http.StatusOK)
	if out.Outcome != "timeout" {
		t.Fatalf("wait = %+v", out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ts.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	s, err := Start(Config{RepoRoot: repo, DataDir: ts.dataDir})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = s.Shutdown(context.Background()) })
	next := &testServer{Server: s, repo: repo, dataDir: ts.dataDir, client: ts.client}
	next.send(t, "reviewed the next day")
	if n := sentNotes(next.feedback(t, 0)); len(n) != 1 || !strings.Contains(n[0], "the next day") {
		t.Fatalf("feedback on the new server = %v", n)
	}
}

func TestASendIsStaleOnceTheCodeChanges(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	kept := ts.send(t, "LGTM")
	if fb := ts.feedback(t, 0); len(fb.Stale) != 0 {
		t.Fatalf("stale with the code as sent: %v", fb.Stale)
	}

	changed := ts.send(t, "LGTM again")
	writeFile(t, ts.repo, "b.txt", "written after the send\n")
	fb := ts.feedback(t, 0)
	if !slices.Equal(fb.Stale, []int64{changed.ID}) || slices.Contains(fb.Stale, kept.ID) {
		t.Fatalf("stale = %v, want [%d]", fb.Stale, changed.ID)
	}
}

func (ts *testServer) status(t *testing.T) Status {
	t.Helper()
	var st Status
	ts.mustStatus(t, ts.do(t, "GET", "/api/status", nil, &st), http.StatusOK)
	return st
}

func TestStatusCountsUndeliveredSendsAndDeliversNothing(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	if st := ts.status(t); st.Unread != 0 || st.Threads == nil || *st.Threads != 0 {
		t.Fatalf("status before any send = %+v", st)
	}
	ts.modify(t)
	ts.draft(t, 1, "why this?")
	ts.send(t, "one question")
	for range 2 {
		if st := ts.status(t); st.Unread != 1 || *st.Threads != 1 {
			t.Fatalf("status after a send = %+v, want 1 unread and 1 thread", st)
		}
	}
	if n := sentNotes(ts.feedback(t, 0)); len(n) != 1 {
		t.Fatalf("feedback after two status calls = %v, want the send", n)
	}
	if st := ts.status(t); st.Unread != 0 || *st.Threads != 1 {
		t.Fatalf("status after delivery = %+v, want 0 unread and the thread still open", st)
	}
}

// A status line asks every few seconds: that must not keep the server up.
func TestStatusPollDoesNotHoldOffIdleShutdown(t *testing.T) {
	ts := startServer(t, initRepo(t), 300*time.Millisecond)
	deadline := time.After(3 * time.Second)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ts.Done():
			return
		case <-deadline:
			t.Fatal("idle shutdown did not fire while status was polled")
		case <-tick.C:
			req, _ := http.NewRequest("GET", ts.URL()+"/api/status", nil)
			req.Header.Set("Authorization", "Bearer "+ts.Token())
			if resp, err := http.DefaultClient.Do(req); err == nil {
				_ = resp.Body.Close()
			}
		}
	}
}

func TestStoredStatusReadsWithoutAServer(t *testing.T) {
	t.Setenv("REVUE_DATA_DIR", t.TempDir())
	repo := initRepo(t)
	if st, err := StoredStatus(repo); err != nil || st.Unread != 0 {
		t.Fatalf("status of a repository never served = %+v, %v", st, err)
	}
	dataDir, err := DataDir(repo)
	if err != nil {
		t.Fatal(err)
	}
	s, err := Start(Config{RepoRoot: repo, DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	ts := &testServer{Server: s, repo: repo, dataDir: dataDir, client: http.DefaultClient}
	ts.send(t, "done reviewing")
	if st, err := StoredStatus(repo); err != nil || st.Unread != 1 {
		t.Fatalf("stored status beside a running server = %+v, %v; want 1 unread", st, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if st, err := StoredStatus(repo); err != nil || st.Unread != 1 || st.Threads != nil {
		t.Fatalf("stored status after shutdown = %+v, %v; want 1 unread and no thread count", st, err)
	}
}
