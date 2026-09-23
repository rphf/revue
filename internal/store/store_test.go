package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "revue.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

func mainThread(line int) NewThread {
	return NewThread{
		Path: "main.go", Status: FileModified, Side: SideAdditions, Line: line,
		HunkHash: "abc", HunkStart: 1,
		OldContent: []byte("old\n"), NewContent: []byte("new\n"),
	}
}

func mustThread(t *testing.T, s *Store, nt NewThread, role, body string, draft bool) (*Thread, *Comment) {
	t.Helper()
	th, c, err := s.CreateThread(nt, role, body, draft)
	if err != nil {
		t.Fatalf("CreateThread: %v", err)
	}
	return th, c
}

func TestMigrationIdempotentAcrossRestarts(t *testing.T) {
	s, path := openTemp(t)
	mustThread(t, s, mainThread(4), RoleReviewer, "hi", true)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	again, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = again.Close() }()
	threads, err := again.ListThreads(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 1 {
		t.Fatalf("threads after reopen = %d, want 1", len(threads))
	}
}

// A database from the review/round era is replaced on first open: its
// tables go, the new ones come, nothing errors.
func TestOldSchemaIsReplaced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "revue.db")
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	// The old tables with their foreign keys and a row in each, so the
	// drops run against enforced constraints the way they do for a
	// real database.
	for _, stmt := range []string{
		"CREATE TABLE reviews (id INTEGER PRIMARY KEY, state TEXT)",
		"CREATE TABLE rounds (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews (id))",
		"CREATE TABLE blobs (hash TEXT PRIMARY KEY, content BLOB NOT NULL)",
		"CREATE TABLE round_files (id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES rounds (id), new_blob TEXT REFERENCES blobs (hash))",
		"CREATE TABLE threads (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews (id), origin_round_id INTEGER NOT NULL REFERENCES rounds (id))",
		"CREATE TABLE thread_anchors (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads (id), round_id INTEGER NOT NULL REFERENCES rounds (id))",
		"CREATE TABLE submissions (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews (id), round_id INTEGER NOT NULL REFERENCES rounds (id))",
		"CREATE TABLE comments (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads (id), submission_id INTEGER REFERENCES submissions (id))",
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER NOT NULL REFERENCES reviews (id))",
		"INSERT INTO reviews (state) VALUES ('open')",
		"INSERT INTO rounds (review_id) VALUES (1)",
		"INSERT INTO blobs (hash, content) VALUES ('h', x'00')",
		"INSERT INTO round_files (round_id, new_blob) VALUES (1, 'h')",
		"INSERT INTO threads (review_id, origin_round_id) VALUES (1, 1)",
		"INSERT INTO thread_anchors (thread_id, round_id) VALUES (1, 1)",
		"INSERT INTO submissions (review_id, round_id) VALUES (1, 1)",
		"INSERT INTO comments (thread_id, submission_id) VALUES (1, 1)",
		"INSERT INTO events (review_id) VALUES (1)",
		"PRAGMA user_version = 1",
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	_ = raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open over old schema: %v", err)
	}
	defer func() { _ = s.Close() }()
	var n int
	err = s.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('reviews', 'rounds', 'round_files', 'thread_anchors', 'submissions')").Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("old tables remaining = %d, want 0", n)
	}
	mustThread(t, s, mainThread(1), RoleReviewer, "new world", true)
}

func TestBlobDedup(t *testing.T) {
	s, _ := openTemp(t)
	content := []byte("same content\n")
	h1, err := s.PutBlob(content)
	if err != nil {
		t.Fatal(err)
	}
	h2, err := s.PutBlob(content)
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 || h1 != BlobHash(content) {
		t.Fatalf("hashes differ: %s %s", h1, h2)
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM blobs").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("blob rows = %d, want 1", count)
	}
	got, err := s.Blob(h1)
	if err != nil || string(got) != string(content) {
		t.Errorf("Blob = %q, %v", got, err)
	}
	if _, err := s.Blob("missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing blob err = %v, want ErrNotFound", err)
	}
}

func TestThreadSnapshotRoundTrip(t *testing.T) {
	s, _ := openTemp(t)
	start := 3
	nt := NewThread{
		Path: "pkg/b.go", OldPath: "a.go", Status: FileRenamed, Side: SideDeletions,
		StartLine: &start, Line: 5, HunkHash: "h", HunkStart: 2,
		OldContent: []byte("one\ntwo\n"), NewContent: nil,
	}
	th, c := mustThread(t, s, nt, RoleReviewer, "why", true)
	got, err := s.GetThread(th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != "pkg/b.go" || got.OldPath != "a.go" || got.Status != FileRenamed || got.Side != SideDeletions {
		t.Errorf("thread fields = %+v", got)
	}
	if got.StartLine == nil || *got.StartLine != 3 || got.Line != 5 {
		t.Errorf("range = %v-%d", got.StartLine, got.Line)
	}
	if got.HunkHash != "h" || got.HunkStart != 2 {
		t.Errorf("hunk = %s@%d", got.HunkHash, got.HunkStart)
	}
	if got.OldBlob != BlobHash([]byte("one\ntwo\n")) || got.NewBlob != "" {
		t.Errorf("blobs = %q %q", got.OldBlob, got.NewBlob)
	}
	if !c.Draft || c.AuthorRole != RoleReviewer || c.ThreadID != th.ID {
		t.Errorf("first comment = %+v", c)
	}
}

func TestDraftsInvisibleUntilSent(t *testing.T) {
	s, _ := openTemp(t)
	th, _ := mustThread(t, s, mainThread(4), RoleReviewer, "draft one", true)

	visible, err := s.ListThreads(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("draft thread visible before send: %d", len(visible))
	}
	all, err := s.ListThreads(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("draft thread missing with includeDrafts: %d", len(all))
	}

	// An agent reply is never a draft, but a thread with only drafts
	// from the reviewer still hides the agent's view of it: the agent
	// cannot reply to what it cannot see, so this only guards the query.
	if _, err := s.AddComment(th.ID, RoleAgent, "agent says", false); err != nil {
		t.Fatal(err)
	}

	sd, err := s.Send("please fix")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if sd.Note != "please fix" {
		t.Errorf("note = %q", sd.Note)
	}
	visible, err = s.ListThreads(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 {
		t.Fatalf("thread not visible after send: %d", len(visible))
	}
	comments, err := s.CommentsForThread(th.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(comments) != 2 {
		t.Fatalf("comments = %d, want 2", len(comments))
	}
	if comments[0].Draft || comments[0].SendID == nil || *comments[0].SendID != sd.ID {
		t.Errorf("sent comment = %+v", comments[0])
	}
	if comments[1].SendID != nil {
		t.Errorf("agent comment got a send id: %+v", comments[1])
	}
	last, err := s.LastSend()
	if err != nil || last == nil || last.ID != sd.ID {
		t.Errorf("LastSend = %+v, %v", last, err)
	}
}

func TestSendRefusesNothing(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Send("  "); !errors.Is(err, ErrNothingToSend) {
		t.Errorf("empty send err = %v, want ErrNothingToSend", err)
	}
	last, err := s.LastSend()
	if err != nil || last != nil {
		t.Errorf("LastSend before any send = %+v, %v", last, err)
	}
	// A note alone is a send.
	if _, err := s.Send("LGTM"); err != nil {
		t.Errorf("note-only send: %v", err)
	}
}

func TestListSendsOldestFirst(t *testing.T) {
	s, _ := openTemp(t)
	sends, err := s.ListSends()
	if err != nil || len(sends) != 0 {
		t.Fatalf("ListSends before any send = %+v, %v", sends, err)
	}
	for _, note := range []string{"first", "second"} {
		if _, err := s.Send(note); err != nil {
			t.Fatal(err)
		}
	}
	sends, err = s.ListSends()
	if err != nil {
		t.Fatal(err)
	}
	if len(sends) != 2 || sends[0].Note != "first" || sends[1].Note != "second" || sends[0].ID >= sends[1].ID {
		t.Errorf("ListSends = %+v", sends)
	}
}

func TestDraftEditAndDeleteRules(t *testing.T) {
	s, _ := openTemp(t)
	th, c := mustThread(t, s, mainThread(4), RoleReviewer, "first", true)
	if err := s.UpdateDraftComment(c.ID, "first, edited"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetComment(c.ID)
	if got.Body != "first, edited" {
		t.Errorf("body = %q", got.Body)
	}
	if _, err := s.Send(""); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateDraftComment(c.ID, "no"); !errors.Is(err, ErrNotDraft) {
		t.Errorf("edit sent comment err = %v, want ErrNotDraft", err)
	}
	if err := s.DeleteDraftComment(c.ID); !errors.Is(err, ErrNotDraft) {
		t.Errorf("delete sent comment err = %v, want ErrNotDraft", err)
	}
	if err := s.UpdateDraftComment(999, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("edit missing err = %v, want ErrNotFound", err)
	}

	// Deleting the last draft of a draft-only thread removes the thread.
	th2, c2 := mustThread(t, s, mainThread(5), RoleReviewer, "second", true)
	if err := s.DeleteDraftComment(c2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetThread(th2.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("thread after last draft deleted: %v", err)
	}
	if _, err := s.GetThread(th.ID); err != nil {
		t.Errorf("sent thread vanished: %v", err)
	}
}

func TestResolveAndCounts(t *testing.T) {
	s, _ := openTemp(t)
	th, _ := mustThread(t, s, mainThread(4), RoleReviewer, "a", true)
	mustThread(t, s, mainThread(6), RoleReviewer, "b", true)
	n, err := s.DraftCount()
	if err != nil || n != 2 {
		t.Errorf("DraftCount = %d, %v", n, err)
	}
	if err := s.SetThreadResolved(th.ID, true); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetThread(th.ID)
	if !got.Resolved {
		t.Error("thread not resolved")
	}
	if err := s.SetThreadResolved(999, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("resolve missing err = %v", err)
	}
}

func TestEventsAreMonotonicAndReplayFromCursor(t *testing.T) {
	s, _ := openTemp(t)
	var ids []int64
	for i := 0; i < 5; i++ {
		e, err := s.AppendEvent("sent", map[string]int{"i": i})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, e.ID)
	}
	for i := 1; i < len(ids); i++ {
		if ids[i] <= ids[i-1] {
			t.Fatalf("ids not increasing: %v", ids)
		}
	}
	since, err := s.EventsSince(ids[2])
	if err != nil {
		t.Fatal(err)
	}
	if len(since) != 2 || since[0].ID != ids[3] || since[1].ID != ids[4] {
		t.Errorf("EventsSince = %+v", since)
	}
	if e := since[0]; e.Type != "sent" || string(e.Payload) != `{"i":3}` {
		t.Errorf("event = %+v", e)
	}
}

func TestWithTxRollsBackOnError(t *testing.T) {
	s, _ := openTemp(t)
	boom := errors.New("boom")
	err := s.WithTx(func(tx *Store) error {
		if _, _, err := tx.CreateThread(mainThread(1), RoleReviewer, "x", true); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("WithTx err = %v", err)
	}
	threads, err := s.ListThreads(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 0 {
		t.Errorf("rolled-back thread persisted: %d", len(threads))
	}
	if err := s.WithTx(func(tx *Store) error {
		return tx.WithTx(func(*Store) error { return nil })
	}); err == nil {
		t.Error("nested WithTx should fail")
	}
}

func TestCommentsForThreadsAndThreadsInSend(t *testing.T) {
	s, _ := openTemp(t)
	a, _ := mustThread(t, s, mainThread(1), RoleReviewer, "a1", true)
	b, _ := mustThread(t, s, mainThread(2), RoleAgent, "b1", false)
	c, _ := mustThread(t, s, mainThread(3), RoleReviewer, "c1", true)
	if _, err := s.AddComment(a.ID, RoleAgent, "a2", false); err != nil {
		t.Fatal(err)
	}
	sd, err := s.Send("")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddComment(b.ID, RoleReviewer, "b2 draft", true); err != nil {
		t.Fatal(err)
	}

	sent, err := s.ThreadsInSend(sd.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[0].ID != a.ID || sent[1].ID != c.ID {
		t.Fatalf("ThreadsInSend = %+v", sent)
	}

	byThread, err := s.CommentsForThreads([]int64{a.ID, b.ID}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := byThread[a.ID]; len(got) != 2 || got[0].Body != "a1" || got[1].Body != "a2" {
		t.Errorf("thread a comments = %+v", got)
	}
	if got := byThread[b.ID]; len(got) != 1 || got[0].Body != "b1" {
		t.Errorf("thread b comments without drafts = %+v", got)
	}
	if _, ok := byThread[c.ID]; ok {
		t.Errorf("unrequested thread c returned")
	}
	withDrafts, err := s.CommentsForThreads([]int64{b.ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := withDrafts[b.ID]; len(got) != 2 || got[1].Body != "b2 draft" {
		t.Errorf("thread b comments with drafts = %+v", got)
	}
	if empty, err := s.CommentsForThreads(nil, true); err != nil || len(empty) != 0 {
		t.Errorf("CommentsForThreads(nil) = %+v, %v", empty, err)
	}
}
