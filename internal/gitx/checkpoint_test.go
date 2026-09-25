package gitx

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rphf/revue/internal/gittest"
)

func TestCheckpointLeavesIndexTreeAndBranchAlone(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "one\ntwo\n")
	write(t, repo, "new.txt", "untracked\n")
	statusBefore := gittest.Git(t, repo, "status", "--porcelain")
	headBefore := gittest.Git(t, repo, "rev-parse", "HEAD")

	if err := Checkpoint(repo); err != nil {
		t.Fatalf("Checkpoint: %v", err)
	}
	if got := gittest.Git(t, repo, "status", "--porcelain"); got != statusBefore {
		t.Errorf("status changed:\n%s\nwant:\n%s", got, statusBefore)
	}
	if got := gittest.Git(t, repo, "rev-parse", "HEAD"); got != headBefore {
		t.Errorf("HEAD moved to %s", got)
	}
	if got := gittest.Git(t, repo, "show", LastSendRef+":new.txt"); got != "untracked\n" {
		t.Errorf("checkpoint lacks the untracked file: %q", got)
	}
	parent := gittest.Git(t, repo, "rev-parse", LastSendRef+"^")
	if parent != headBefore {
		t.Errorf("checkpoint parent = %s, want HEAD %s", parent, headBefore)
	}
}

func TestCheckpointWithoutCommitsOrIdentity(t *testing.T) {
	repo := gittest.Init(t)
	gittest.Git(t, repo, "config", "--unset", "user.email")
	gittest.Git(t, repo, "config", "--unset", "user.name")
	write(t, repo, "a.txt", "first\n")
	if err := Checkpoint(repo); err != nil {
		t.Fatalf("Checkpoint on an unborn branch: %v", err)
	}
	if got := gittest.Git(t, repo, "show", LastSendRef+":a.txt"); got != "first\n" {
		t.Errorf("checkpoint a.txt = %q", got)
	}
}

func TestDiffSinceCheckpointFollowsUntrackedFiles(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	write(t, repo, ".gitignore", "*.log\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "one\ntwo\n")
	write(t, repo, "kept.txt", "kept\n")
	write(t, repo, "gone.txt", "gone\n")
	write(t, repo, "same.txt", "same\n")
	if err := Checkpoint(repo); err != nil {
		t.Fatal(err)
	}

	write(t, repo, "a.txt", "one\ntwo\nthree\n")
	write(t, repo, "kept.txt", "kept\nedited\n")
	if err := os.Remove(filepath.Join(repo, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "fresh.txt", "fresh\n")
	write(t, repo, "noise.log", "ignored\n")

	res, err := Capture(repo, []string{LastSendRef}, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	want := map[string]string{
		"a.txt":     StatusModified,
		"kept.txt":  StatusModified,
		"gone.txt":  StatusDeleted,
		"fresh.txt": StatusAdded,
	}
	if len(res.Files) != len(want) {
		t.Errorf("files = %+v, want %v", res.Files, want)
	}
	for path, status := range want {
		f := fileByPath(res, path)
		if f == nil || f.Status != status {
			t.Errorf("%s = %+v, want %s", path, f, status)
		}
	}
	if f := fileByPath(res, "fresh.txt"); f != nil && string(f.NewContent) != "fresh\n" {
		t.Errorf("fresh.txt content = %q", f.NewContent)
	}
	if f := fileByPath(res, "kept.txt"); f != nil &&
		(string(f.OldContent) != "kept\n" || string(f.NewContent) != "kept\nedited\n") {
		t.Errorf("kept.txt sides = %q -> %q", f.OldContent, f.NewContent)
	}
	if !strings.Contains(res.Patch, "+three") || strings.Contains(res.Patch, "+two") {
		t.Errorf("patch is not the change since the send:\n%s", res.Patch)
	}
	if status := gittest.Git(t, repo, "status", "--porcelain"); strings.Contains(status, "A ") {
		t.Errorf("the capture staged files:\n%s", status)
	}
}

func TestFingerprintSinceCheckpointFollowsUntrackedEdits(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	commitAll(t, repo, "c1")
	write(t, repo, "u.txt", "v1\n")
	if err := Checkpoint(repo); err != nil {
		t.Fatal(err)
	}
	args := []string{LastSendRef}
	before, _, err := Fingerprint(repo, args)
	if err != nil {
		t.Fatal(err)
	}
	write(t, repo, "u.txt", "v2\n")
	after, _, err := Fingerprint(repo, args)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Error("an edit to an untracked file left the fingerprint unchanged")
	}
}

func TestDiffSinceCheckpointBeforeAnySend(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\n")
	commitAll(t, repo, "c1")
	if _, err := Capture(repo, []string{LastSendRef}, nil); !errors.Is(err, ErrNoCheckpoint) {
		t.Errorf("Capture before a send: %v, want ErrNoCheckpoint", err)
	}
	if _, _, err := Fingerprint(repo, []string{LastSendRef}); !errors.Is(err, ErrNoCheckpoint) {
		t.Errorf("Fingerprint before a send: %v, want ErrNoCheckpoint", err)
	}
}
