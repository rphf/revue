package store

import (
	"slices"
	"testing"
	"time"
)

func TestThreadRecordsItsOrigin(t *testing.T) {
	s, _ := openTemp(t)
	nt := mainThread(4)
	nt.Branch, nt.Head, nt.Args = "feat", "abc123", []string{"main...HEAD"}
	th, _ := mustThread(t, s, nt, RoleReviewer, "hi", false)
	got, err := s.GetThread(th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Branch != "feat" || got.Head != "abc123" || !slices.Equal(got.Args, []string{"main...HEAD"}) || !got.HasOrigin() {
		t.Fatalf("origin = %q %q %v", got.Branch, got.Head, got.Args)
	}
	legacy, _ := mustThread(t, s, mainThread(5), RoleReviewer, "old", false)
	if legacy.HasOrigin() || legacy.Args == nil || len(legacy.Args) != 0 {
		t.Fatalf("thread without origin = %+v", legacy)
	}
}

func TestArchiveHidesThreadsAndSkipsDrafts(t *testing.T) {
	s, _ := openTemp(t)
	sent, _ := mustThread(t, s, mainThread(1), RoleReviewer, "sent", false)
	draft, _ := mustThread(t, s, mainThread(2), RoleReviewer, "draft", true)

	got, err := s.ArchiveThreads([]int64{sent.ID, draft.ID}, "c0ffee")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []int64{sent.ID}) {
		t.Fatalf("archived = %v, want only the sent thread", got)
	}
	again, err := s.ArchiveThreads([]int64{sent.ID}, "later")
	if err != nil || len(again) != 0 {
		t.Fatalf("archiving twice = %v, %v", again, err)
	}

	visible, err := s.ListThreads(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].ID != draft.ID {
		t.Fatalf("visible = %v, want the draft thread only", visible)
	}
	archived, err := s.ListArchivedThreads()
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) != 1 || archived[0].ArchivedHead != "c0ffee" || archived[0].ArchivedAt == nil {
		t.Fatalf("archived list = %+v", archived)
	}

	if err := s.UnarchiveThread(sent.ID); err != nil {
		t.Fatal(err)
	}
	if visible, _ := s.ListThreads(false); len(visible) != 1 || visible[0].ID != sent.ID || visible[0].ArchivedAt != nil || !visible[0].Kept {
		t.Fatalf("after unarchive = %+v", visible)
	}
	if err := s.UnarchiveThread(999); err != ErrNotFound {
		t.Fatalf("unarchive unknown = %v", err)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	s, _ := openTemp(t)
	if _, ok, err := s.Setting("autoArchiveLanded"); ok || err != nil {
		t.Fatalf("unset setting = %v %v", ok, err)
	}
	for _, v := range []string{"true", "false"} {
		if err := s.SetSetting("autoArchiveLanded", v); err != nil {
			t.Fatal(err)
		}
		if got, ok, err := s.Setting("autoArchiveLanded"); got != v || !ok || err != nil {
			t.Fatalf("setting = %q %v %v, want %q", got, ok, err, v)
		}
	}
}

// Timestamps keep a variable number of fractional digits, so retention
// compares them as times, not as strings.
func TestPruneArchivedComparesTimesNotStrings(t *testing.T) {
	s, _ := openTemp(t)
	old, _ := mustThread(t, s, mainThread(1), RoleReviewer, "old", false)
	recent, _ := mustThread(t, s, mainThread(2), RoleReviewer, "recent", false)
	if _, err := s.ArchiveThreads([]int64{old.ID, recent.ID}, "h"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.q.Exec("UPDATE threads SET archived_at = ? WHERE id = ?", "2026-01-01T00:00:05.1Z", old.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.q.Exec("UPDATE threads SET archived_at = ? WHERE id = ?", "2026-01-01T00:00:05.12Z", recent.ID); err != nil {
		t.Fatal(err)
	}
	cutoff := time.Date(2026, 1, 1, 0, 0, 5, 110_000_000, time.UTC)
	n, err := s.PruneArchived(cutoff)
	if err != nil || n != 1 {
		t.Fatalf("pruned = %d, %v; want 1", n, err)
	}
	if _, err := s.GetThread(old.ID); err != ErrNotFound {
		t.Fatalf("old thread still there: %v", err)
	}
	if _, err := s.GetThread(recent.ID); err != nil {
		t.Fatalf("recent thread gone: %v", err)
	}
	if left, _ := s.CommentsForThread(old.ID, true); len(left) != 0 {
		t.Fatalf("comments of the pruned thread = %d", len(left))
	}
}

func TestPruneBlobsKeepsSnapshotsInUse(t *testing.T) {
	s, _ := openTemp(t)
	keep := mainThread(1)
	keep.OldContent, keep.NewContent = []byte("keep old\n"), []byte("keep new\n")
	drop := mainThread(2)
	drop.OldContent, drop.NewContent = []byte("drop old\n"), []byte("drop new\n")
	kept, _ := mustThread(t, s, keep, RoleReviewer, "k", false)
	dropped, _ := mustThread(t, s, drop, RoleReviewer, "d", false)
	if _, err := s.ArchiveThreads([]int64{dropped.ID}, "h"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PruneArchived(time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	n, err := s.PruneBlobs()
	if err != nil || n != 2 {
		t.Fatalf("pruned blobs = %d, %v; want 2", n, err)
	}
	for _, h := range []string{kept.OldBlob, kept.NewBlob} {
		if _, err := s.Blob(h); err != nil {
			t.Fatalf("blob of a live thread gone: %v", err)
		}
	}
}

func TestPruneEventsKeepsCursorsValid(t *testing.T) {
	s, _ := openTemp(t)
	first, _ := s.AppendEvent("a", nil)
	if _, err := s.q.Exec("UPDATE events SET created_at = ? WHERE id = ?", "2020-01-01T00:00:00Z", first.ID); err != nil {
		t.Fatal(err)
	}
	second, _ := s.AppendEvent("b", nil)
	if n, err := s.PruneEvents(time.Now().Add(-time.Hour)); err != nil || n != 1 {
		t.Fatalf("pruned events = %d, %v", n, err)
	}
	third, _ := s.AppendEvent("c", nil)
	if third.ID <= second.ID {
		t.Fatalf("event id reused: %d after %d", third.ID, second.ID)
	}
	since, err := s.EventsSince(0)
	if err != nil || len(since) != 2 || since[0].ID != second.ID {
		t.Fatalf("events after an old cursor = %v, %v", since, err)
	}
}

func TestVacuumShrinksAFragmentedFile(t *testing.T) {
	s, _ := openTemp(t)
	big := make([]byte, 64<<10)
	for i := range 20 {
		nt := mainThread(i + 1)
		big[0] = byte(i)
		nt.NewContent = append([]byte{}, big...)
		th, _ := mustThread(t, s, nt, RoleReviewer, "x", false)
		if _, err := s.ArchiveThreads([]int64{th.ID}, "h"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PruneArchived(time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PruneBlobs(); err != nil {
		t.Fatal(err)
	}
	free, total, _, err := s.Fragmentation()
	if err != nil || free == 0 {
		t.Fatalf("free pages after deleting = %d of %d, %v", free, total, err)
	}
	if err := s.Vacuum(); err != nil {
		t.Fatal(err)
	}
	after, newTotal, _, err := s.Fragmentation()
	if err != nil || after != 0 || newTotal >= total {
		t.Fatalf("after vacuum: free %d, pages %d (was %d), %v", after, newTotal, total, err)
	}
}
