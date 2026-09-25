package gitx

import (
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
		"revue-index-garbled",
		"someone-else.tmp",
	} {
		if err := os.WriteFile(filepath.Join(os.TempDir(), name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stale := time.Now().Add(-2 * scratchMaxAge)
	if err := os.Chtimes(filepath.Join(os.TempDir(), fmt.Sprintf("revue-index-%d-3", me)), stale, stale); err != nil {
		t.Fatal(err)
	}

	if n := SweepScratch(); n != 4 {
		t.Errorf("removed %d, want 4", n)
	}
	want := []string{fmt.Sprintf("revue-index-%d-2", me), "someone-else.tmp"}
	if left := scratchFiles(t); !slices.Equal(left, want) {
		t.Errorf("left = %v, want %v", left, want)
	}
}
