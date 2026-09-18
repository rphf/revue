package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
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

func mustReview(t *testing.T, s *Store) *Review {
	t.Helper()
	r, err := s.CreateReview("/repo", "main", []string{"HEAD~1"})
	if err != nil {
		t.Fatalf("CreateReview: %v", err)
	}
	return r
}

func mustRound(t *testing.T, s *Store, reviewID int64) *Round {
	t.Helper()
	round, err := s.CreateRound(reviewID, "diff --git a/f b/f\n", []NewRoundFile{
		{Path: "f", Status: FileModified, OldContent: []byte("old"), NewContent: []byte("new")},
	})
	if err != nil {
		t.Fatalf("CreateRound: %v", err)
	}
	return round
}

func TestMigrationIdempotentAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "revue.db")
	s1, err := Open(path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	r := mustReview(t, s1)
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen twice more: migrations must not re-apply or error.
	for i := 0; i < 2; i++ {
		s, err := Open(path)
		if err != nil {
			t.Fatalf("reopen %d: %v", i, err)
		}
		got, err := s.GetReview(r.ID)
		if err != nil {
			t.Fatalf("GetReview after reopen: %v", err)
		}
		if got.Branch != "main" {
			t.Errorf("branch = %q, want main", got.Branch)
		}
		_ = s.Close()
	}
}

func TestSchemaSurvivesDeleteAndReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "revue.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	mustReview(t, s)
	_ = s.Close()

	for _, f := range []string{path, path + "-wal", path + "-shm"} {
		_ = os.Remove(f)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("Open after delete: %v", err)
	}
	defer func() { _ = s2.Close() }()
	r := mustReview(t, s2)
	if r.ID != 1 {
		t.Errorf("fresh db review id = %d, want 1", r.ID)
	}
}

func TestBlobDedup(t *testing.T) {
	s, _ := openTemp(t)
	content := []byte("same content")
	h1, err := s.PutBlob(content)
	if err != nil {
		t.Fatalf("PutBlob 1: %v", err)
	}
	h2, err := s.PutBlob(content)
	if err != nil {
		t.Fatalf("PutBlob 2: %v", err)
	}
	if h1 != h2 {
		t.Errorf("hashes differ: %s vs %s", h1, h2)
	}
	var count int
	if err := s.q.QueryRow("SELECT COUNT(*) FROM blobs").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("blob rows = %d, want 1", count)
	}

	// Same content in two rounds' files: still one row.
	r := mustReview(t, s)
	for i := 0; i < 2; i++ {
		if _, err := s.CreateRound(r.ID, "patch", []NewRoundFile{
			{Path: "a.txt", Status: FileModified, OldContent: content, NewContent: []byte("changed")},
		}); err != nil {
			t.Fatalf("CreateRound %d: %v", i, err)
		}
	}
	if err := s.q.QueryRow("SELECT COUNT(*) FROM blobs").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 { // "same content" + "changed"
		t.Errorf("blob rows = %d, want 2", count)
	}
}

func TestEventIDsStrictlyMonotonicUnderInterleavedWrites(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)

	const writers, perWriter = 8, 25
	var wg sync.WaitGroup
	ids := make(chan int64, writers*perWriter)
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				e, err := s.AppendEvent(r.ID, "test", map[string]int{"writer": w, "n": i})
				if err != nil {
					t.Errorf("AppendEvent: %v", err)
					return
				}
				ids <- e.ID
			}
		}(w)
	}
	wg.Wait()
	close(ids)

	seen := map[int64]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate event id %d", id)
		}
		seen[id] = true
	}
	if len(seen) != writers*perWriter {
		t.Fatalf("got %d ids, want %d", len(seen), writers*perWriter)
	}

	events, err := s.EventsSince(r.ID, 0)
	if err != nil {
		t.Fatalf("EventsSince: %v", err)
	}
	for i := 1; i < len(events); i++ {
		if events[i].ID <= events[i-1].ID {
			t.Fatalf("event ids not strictly increasing: %d after %d", events[i].ID, events[i-1].ID)
		}
	}
}

func TestEventsSinceCursor(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	var cursor int64
	for i := 0; i < 5; i++ {
		e, err := s.AppendEvent(r.ID, "test", i)
		if err != nil {
			t.Fatal(err)
		}
		if i == 2 {
			cursor = e.ID
		}
	}
	events, err := s.EventsSince(r.ID, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events since cursor = %d, want 2", len(events))
	}
}

func TestReviewStateMachineKTD8(t *testing.T) {
	cases := []struct {
		name string
		from string
		to   string
		ok   bool
	}{
		{"open to approved", StateOpen, StateApproved, true},
		{"open to closed", StateOpen, StateClosed, true},
		{"approved reopens", StateApproved, StateOpen, true},
		{"closed reopens", StateClosed, StateOpen, true},
		{"approved to closed is illegal", StateApproved, StateClosed, false},
		{"closed to approved is illegal", StateClosed, StateApproved, false},
		{"open to open is illegal", StateOpen, StateOpen, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openTemp(t)
			r := mustReview(t, s)
			// Drive the review into the starting state.
			if tc.from != StateOpen {
				if err := s.SetReviewState(r.ID, tc.from); err != nil {
					t.Fatalf("setup transition to %s: %v", tc.from, err)
				}
			}
			err := s.SetReviewState(r.ID, tc.to)
			if tc.ok && err != nil {
				t.Errorf("%s -> %s: unexpected error %v", tc.from, tc.to, err)
			}
			if !tc.ok {
				if !errors.Is(err, ErrIllegalTransition) {
					t.Errorf("%s -> %s: want ErrIllegalTransition, got %v", tc.from, tc.to, err)
				}
				got, _ := s.GetReview(r.ID)
				if got.State != tc.from {
					t.Errorf("state mutated to %s on illegal transition", got.State)
				}
			}
		})
	}
}

func TestRoundsOnlyUnderOpen(t *testing.T) {
	for _, state := range []string{StateApproved, StateClosed} {
		t.Run(state, func(t *testing.T) {
			s, _ := openTemp(t)
			r := mustReview(t, s)
			mustRound(t, s, r.ID)
			if err := s.SetReviewState(r.ID, state); err != nil {
				t.Fatal(err)
			}
			_, err := s.CreateRound(r.ID, "patch", nil)
			if !errors.Is(err, ErrReviewNotOpen) {
				t.Errorf("CreateRound under %s: want ErrReviewNotOpen, got %v", state, err)
			}
		})
	}
}

func TestDraftsExcludedFromSubmittedFeedback(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	round := mustRound(t, s, r.ID)

	anchor := Anchor{Path: "f", Side: SideAdditions, Line: 3}
	th, _, err := s.CreateThread(r.ID, round.ID, anchor, RoleReviewer, "draft note", true)
	if err != nil {
		t.Fatalf("CreateThread: %v", err)
	}

	// Before submit: invisible without drafts, visible with.
	threads, err := s.ThreadsForReview(r.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 0 {
		t.Errorf("draft-only thread visible in submitted view: %d threads", len(threads))
	}
	threads, err = s.ThreadsForReview(r.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 1 {
		t.Errorf("draft thread missing from draft view: %d threads", len(threads))
	}

	// Submit: drafts promote and become visible, tied to the submission.
	sub, err := s.Submit(r.ID, round.ID, VerdictRequestChanges, "please fix")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	threads, err = s.ThreadsForReview(r.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 1 {
		t.Fatalf("submitted thread not visible: %d threads", len(threads))
	}
	comments, err := s.CommentsForThread(th.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(comments) != 1 || comments[0].Draft {
		t.Fatalf("comment not promoted: %+v", comments)
	}
	if comments[0].SubmissionID == nil || *comments[0].SubmissionID != sub.ID {
		t.Errorf("comment not tied to submission %d: %+v", sub.ID, comments[0])
	}

	// Agent replies are never drafts and are immediately visible.
	if _, err := s.AddComment(th.ID, RoleAgent, "on it", false); err != nil {
		t.Fatal(err)
	}
	comments, _ = s.CommentsForThread(th.ID, false)
	if len(comments) != 2 {
		t.Errorf("agent reply not visible: %d comments", len(comments))
	}
}

func TestDraftEditAndDeleteRules(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	round := mustRound(t, s, r.ID)
	anchor := Anchor{Path: "f", Side: SideAdditions, Line: 1}

	th, c, err := s.CreateThread(r.ID, round.ID, anchor, RoleReviewer, "v1", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateDraftComment(c.ID, "v2"); err != nil {
		t.Fatalf("UpdateDraftComment: %v", err)
	}
	got, _ := s.GetComment(c.ID)
	if got.Body != "v2" {
		t.Errorf("body = %q, want v2", got.Body)
	}

	// Deleting the only draft removes the thread and its anchors.
	if err := s.DeleteDraftComment(c.ID); err != nil {
		t.Fatalf("DeleteDraftComment: %v", err)
	}
	if _, err := s.GetThread(th.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("thread should be gone, got %v", err)
	}

	// Submitted comments are immutable.
	_, c2, err := s.CreateThread(r.ID, round.ID, anchor, RoleReviewer, "keep", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit(r.ID, round.ID, VerdictComment, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateDraftComment(c2.ID, "nope"); !errors.Is(err, ErrNotDraft) {
		t.Errorf("editing submitted comment: want ErrNotDraft, got %v", err)
	}
	if err := s.DeleteDraftComment(c2.ID); !errors.Is(err, ErrNotDraft) {
		t.Errorf("deleting submitted comment: want ErrNotDraft, got %v", err)
	}
}

func TestWithTxRollsBackOnError(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	sentinel := errors.New("boom")
	err := s.WithTx(func(tx *Store) error {
		if _, err := tx.AppendEvent(r.ID, "will-roll-back", nil); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("WithTx error = %v, want sentinel", err)
	}
	events, err := s.EventsSince(r.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Errorf("rolled-back event visible: %d events", len(events))
	}
}

func TestAnchorUpsertPerRound(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	r1 := mustRound(t, s, r.ID)
	th, _, err := s.CreateThread(r.ID, r1.ID, Anchor{Path: "f", Side: SideAdditions, Line: 3}, RoleReviewer, "note", true)
	if err != nil {
		t.Fatal(err)
	}
	r2 := mustRound(t, s, r.ID)
	if err := s.UpsertAnchor(th.ID, r2.ID, Anchor{Path: "f", Side: SideAdditions, Line: 7}, AnchorLive, "h2"); err != nil {
		t.Fatal(err)
	}
	// Re-upsert same round updates in place.
	if err := s.UpsertAnchor(th.ID, r2.ID, Anchor{Path: "f", Side: SideAdditions, Line: 8}, AnchorOutdated, "h3"); err != nil {
		t.Fatal(err)
	}
	anchors, err := s.AnchorsForThread(th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(anchors) != 2 {
		t.Fatalf("anchors = %d, want 2 (one per round)", len(anchors))
	}
	last := anchors[1]
	if last.Line != 8 || last.State != AnchorOutdated || last.HunkHash != "h3" {
		t.Errorf("upsert did not update: %+v", last)
	}
}

func TestRoundSequencePerReview(t *testing.T) {
	s, _ := openTemp(t)
	a := mustReview(t, s)
	b := mustReview(t, s)
	for i := 1; i <= 3; i++ {
		round := mustRound(t, s, a.ID)
		if round.Seq != i {
			t.Errorf("review a round %d seq = %d", i, round.Seq)
		}
	}
	round := mustRound(t, s, b.ID)
	if round.Seq != 1 {
		t.Errorf("review b first round seq = %d, want 1 (sequences are per review)", round.Seq)
	}
	latest, err := s.LatestRound(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.Seq != 3 {
		t.Errorf("latest seq = %d, want 3", latest.Seq)
	}
}

func TestRoundFilesRoundTrip(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	round, err := s.CreateRound(r.ID, "patch", []NewRoundFile{
		{Path: "new/name.go", OldPath: "old/name.go", Status: FileRenamed, OldContent: []byte("x"), NewContent: []byte("x")},
		{Path: "img.png", Status: FileAdded, IsBinary: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	files, err := s.FilesForRound(round.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("files = %d, want 2", len(files))
	}
	byPath := map[string]*RoundFile{}
	for _, f := range files {
		byPath[f.Path] = f
	}
	ren := byPath["new/name.go"]
	if ren == nil || ren.OldPath != "old/name.go" || ren.Status != FileRenamed {
		t.Errorf("rename metadata lost: %+v", ren)
	}
	if ren.OldBlob == "" || ren.NewBlob == "" {
		t.Errorf("rename blobs missing: %+v", ren)
	}
	bin := byPath["img.png"]
	if bin == nil || !bin.IsBinary || bin.NewBlob != "" {
		t.Errorf("binary file should have no blobs: %+v", bin)
	}
	content, err := s.Blob(ren.NewBlob)
	if err != nil || string(content) != "x" {
		t.Errorf("blob content = %q, %v", content, err)
	}
}

func TestSubmissionVerdicts(t *testing.T) {
	s, _ := openTemp(t)
	r := mustReview(t, s)
	round := mustRound(t, s, r.ID)
	for i, v := range []string{VerdictComment, VerdictRequestChanges, VerdictApprove} {
		if _, err := s.Submit(r.ID, round.ID, v, fmt.Sprintf("s%d", i)); err != nil {
			t.Fatalf("Submit %s: %v", v, err)
		}
	}
	subs, err := s.SubmissionsForReview(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 3 {
		t.Fatalf("submissions = %d, want 3", len(subs))
	}
	if subs[2].Verdict != VerdictApprove || subs[2].Summary != "s2" {
		t.Errorf("last submission = %+v", subs[2])
	}
}
