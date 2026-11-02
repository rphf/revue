package gitx

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/rphf/revue/internal/gittest"
)

// scratchFiles lists what is left in the temp directory, which the test
// points at a directory of its own.
func scratchFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestDiffsLeaveNoScratchFilesBehind(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	commitAll(t, repo, "c1")
	write(t, repo, "new.txt", "untracked\n")

	if _, err := Capture(repo, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := IgnoringSpace(repo, nil, &Result{}); err != nil {
		t.Fatal(err)
	}
	if err := checkpoint(repo); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Fingerprint(repo, []string{LastSendRef}); err != nil {
		t.Fatal(err)
	}
	if _, err := Capture(repo, []string{LastSendRef}, nil); err != nil {
		t.Fatal(err)
	}
	if left := scratchFiles(t); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestRemoveScratchRemovesTheRepositorysOpenFiles(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	repo, other := gittest.Init(t), gittest.Init(t)
	// An empty index is not copied: git creates the file itself.
	for _, r := range []string{repo, other} {
		write(t, r, "a.txt", "one\n")
		commitAll(t, r, "c1")
	}
	_, done, err := scratchIndex(repo)
	if err != nil {
		t.Fatal(err)
	}
	_, otherDone, err := scratchIndex(other)
	if err != nil {
		t.Fatal(err)
	}
	defer otherDone()

	RemoveScratch(repo)
	if left := scratchFiles(t); len(left) != 1 {
		t.Fatalf("after RemoveScratch: %v, want only the other repository's", left)
	}
	done()
	otherDone()
	if left := scratchFiles(t); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestSweepScratchRemovesWhatNoLiveProcessOwns(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	gone := exec.Command("true")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	dead, me := gone.Process.Pid, os.Getpid()
	for _, name := range []string{
		fmt.Sprintf("revue-index-%d-1", dead),
		fmt.Sprintf("revue-index-%d-1.lock", dead),
		fmt.Sprintf("revue-index-%d-2", me),
		fmt.Sprintf("revue-index-%d-3", me),
		fmt.Sprintf("revue-index-%d-shared-4", me),
		fmt.Sprintf("revue-index-%d-shared-5", dead),
		"revue-index-garbled",
		"someone-else.tmp",
	} {
		if err := os.WriteFile(filepath.Join(os.TempDir(), name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stale := time.Now().Add(-2 * scratchMaxAge)
	for _, name := range []string{fmt.Sprintf("revue-index-%d-3", me), fmt.Sprintf("revue-index-%d-shared-4", me)} {
		if err := os.Chtimes(filepath.Join(os.TempDir(), name), stale, stale); err != nil {
			t.Fatal(err)
		}
	}

	if n := SweepScratch(); n != 5 {
		t.Errorf("removed %d, want 5", n)
	}
	want := []string{fmt.Sprintf("revue-index-%d-2", me), fmt.Sprintf("revue-index-%d-shared-4", me), "someone-else.tmp"}
	if left := scratchFiles(t); !slices.Equal(left, want) {
		t.Errorf("left = %v, want %v", left, want)
	}
}

// An edit of the same size in the same second as the last commit looks
// clean by its stat alone; git checks such "racily clean" files by
// content only while the index is not newer than them. The scratch copy
// keeps the index's time, so the edit is still seen a second later.
func TestWorkingTreeSeesASameSizeEditFromTheCommitsSecond(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	repo := gittest.Init(t)
	write(t, repo, "main.go", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "main.go", "v2\n")
	time.Sleep(1100 * time.Millisecond)

	tree, err := WorkingTree(repo)
	if err != nil {
		t.Fatal(err)
	}
	got := gittest.Git(t, repo, "cat-file", "-p", tree+":main.go")
	if got != "v2\n" {
		t.Errorf("tree has main.go = %q, want the edit", got)
	}
}

// git diff refreshes the index it reads when a tracked file's stat no
// longer matches, holding index.lock while it writes; a user's git add
// or commit fails meanwhile. Every diff revue runs leaves the
// repository's index alone.
func TestDiffsLeaveTheIndexAlone(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	commitAll(t, repo, "c1")
	write(t, repo, "b.txt", "two\n")
	commitAll(t, repo, "c2")
	write(t, repo, "b.txt", "three\n")
	// Same content, another time: stat-dirty, which git would refresh.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(repo, "a.txt"), old, old); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(repo, ".git", "index")
	before, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{nil, {"--", "a.txt"}, {"HEAD~1"}, {"--staged"}, {"HEAD~1..HEAD"}} {
		if _, _, err := Fingerprint(repo, args); err != nil {
			t.Fatal(err)
		}
		if _, err := Capture(repo, args, nil); err != nil {
			t.Fatal(err)
		}
		if _, _, err := IgnoringSpace(repo, args, &Result{}); err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(index)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(after, before) {
			t.Fatalf("diff of %q rewrote the index", args)
		}
	}
	RemoveScratch(repo)
	if left := scratchFiles(t); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

// The diffs that only read the index share one copy of it per
// repository, where git keeps its refresh: a file whose stat changed but
// not its content is hashed once, not on every poll. The copy is made
// again when the repository's index changes.
func TestDiffsShareACopyOfTheIndexUntilItChanges(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	commitAll(t, repo, "c1")
	index := filepath.Join(repo, ".git", "index")
	// An index older than the file: git finds a.txt stat-dirty and
	// writes its refresh, at the current time, into the copy.
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(filepath.Join(repo, "a.txt"), old.Add(time.Hour), old.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(index, old, old); err != nil {
		t.Fatal(err)
	}
	copyTime := func() time.Time {
		t.Helper()
		left := scratchFiles(t)
		if len(left) != 1 {
			t.Fatalf("scratch files = %v, want the shared copy", left)
		}
		info, err := os.Stat(filepath.Join(os.TempDir(), left[0]))
		if err != nil {
			t.Fatal(err)
		}
		return info.ModTime()
	}

	if _, _, err := Fingerprint(repo, nil); err != nil {
		t.Fatal(err)
	}
	refreshed := copyTime()
	if !refreshed.After(old.Add(time.Minute)) {
		t.Fatalf("copy time = %v, want git's refresh", refreshed)
	}
	if _, _, err := Fingerprint(repo, nil); err != nil {
		t.Fatal(err)
	}
	if got := copyTime(); !got.Equal(refreshed) {
		t.Errorf("second diff: copy time = %v, want the refreshed copy reused (%v)", got, refreshed)
	}

	// git add refreshes the repository's index, so the new copy needs no
	// refresh and keeps the index's time.
	gittest.Git(t, repo, "add", "a.txt")
	info, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Fingerprint(repo, nil); err != nil {
		t.Fatal(err)
	}
	if got := copyTime(); !got.Equal(info.ModTime()) {
		t.Errorf("after git add: copy time = %v, want a new copy of the index (%v)", got, info.ModTime())
	}

	RemoveScratch(repo)
	if left := scratchFiles(t); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}
