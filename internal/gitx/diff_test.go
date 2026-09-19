package gitx

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initRepo builds a fixture repo in a temp dir, isolated from the
// developer's git config.
func initRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q", "-b", "main")
	mustGit(t, dir, "config", "user.email", "test@test")
	mustGit(t, dir, "config", "user.name", "test")
	return dir
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func write(t *testing.T, dir, path, content string) {
	t.Helper()
	full := filepath.Join(dir, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commitAll(t *testing.T, dir, msg string) {
	t.Helper()
	mustGit(t, dir, "add", "-A")
	mustGit(t, dir, "commit", "-q", "-m", msg)
}

func fileByPath(res *Result, path string) *File {
	for i := range res.Files {
		if res.Files[i].Path == path {
			return &res.Files[i]
		}
	}
	return nil
}

func TestWorkingTreeDiff(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "one\ntwo\nthree\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "one\nTWO\nthree\n")

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "a.txt")
	if f == nil || f.Status != StatusModified {
		t.Fatalf("a.txt not captured as modified: %+v", res.Files)
	}
	if string(f.OldContent) != "one\ntwo\nthree\n" {
		t.Errorf("old content = %q", f.OldContent)
	}
	if string(f.NewContent) != "one\nTWO\nthree\n" {
		t.Errorf("new content = %q", f.NewContent)
	}
	if !strings.Contains(res.Patch, "-two") || !strings.Contains(res.Patch, "+TWO") {
		t.Errorf("patch missing change:\n%s", res.Patch)
	}
}

func TestStagedDiff(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "v2\n")
	mustGit(t, repo, "add", "a.txt")
	// A further unstaged edit must NOT appear in a staged capture.
	write(t, repo, "a.txt", "v3-unstaged\n")

	res, err := Capture(repo, []string{"--staged"})
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "a.txt")
	if f == nil {
		t.Fatal("a.txt missing")
	}
	if string(f.NewContent) != "v2\n" {
		t.Errorf("staged new content = %q, want index version v2", f.NewContent)
	}
	if strings.Contains(res.Patch, "v3-unstaged") {
		t.Errorf("staged patch leaked worktree content:\n%s", res.Patch)
	}
}

func TestCommitRange(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "first\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "second\n")
	commitAll(t, repo, "c2")
	// Worktree noise must not leak into a range capture.
	write(t, repo, "a.txt", "worktree-noise\n")

	res, err := Capture(repo, []string{"HEAD~1..HEAD"})
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "a.txt")
	if f == nil {
		t.Fatal("a.txt missing")
	}
	if string(f.OldContent) != "first\n" || string(f.NewContent) != "second\n" {
		t.Errorf("range contents = %q -> %q", f.OldContent, f.NewContent)
	}
	if strings.Contains(res.Patch, "worktree-noise") {
		t.Error("range capture leaked worktree content")
	}
}

func TestBranchToBranch(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "base\n")
	commitAll(t, repo, "c1")
	mustGit(t, repo, "checkout", "-q", "-b", "feature")
	write(t, repo, "a.txt", "feature-change\n")
	commitAll(t, repo, "c2")
	mustGit(t, repo, "checkout", "-q", "main")

	res, err := Capture(repo, []string{"main..feature"})
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "a.txt")
	if f == nil || string(f.NewContent) != "feature-change\n" {
		t.Fatalf("branch diff wrong: %+v", f)
	}
}

func TestRenameWithUnchangedContentCarriesMetadata(t *testing.T) {
	repo := initRepo(t)
	content := strings.Repeat("stable line\n", 20)
	write(t, repo, "old/name.txt", content)
	commitAll(t, repo, "c1")
	if err := os.MkdirAll(filepath.Join(repo, "new"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "mv", "old/name.txt", "new/name.txt")
	commitAll(t, repo, "c2")

	res, err := Capture(repo, []string{"HEAD~1..HEAD"})
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "new/name.txt")
	if f == nil {
		t.Fatalf("renamed file missing: %+v", res.Files)
	}
	if f.Status != StatusRenamed || f.OldPath != "old/name.txt" {
		t.Errorf("rename metadata: status=%s oldPath=%s", f.Status, f.OldPath)
	}
	if string(f.OldContent) != content || string(f.NewContent) != content {
		t.Error("rename contents should be unchanged")
	}
}

func TestBinaryFileFlaggedNoBlobs(t *testing.T) {
	repo := initRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "img.dat"), []byte{0x00, 0x01, 0xFF, 0xFE}, 0o644); err != nil {
		t.Fatal(err)
	}
	commitAll(t, repo, "c1")
	if err := os.WriteFile(filepath.Join(repo, "img.dat"), []byte{0x00, 0xAA, 0xBB}, 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "img.dat")
	if f == nil {
		t.Fatal("img.dat missing")
	}
	if !f.IsBinary {
		t.Error("binary file not flagged")
	}
	if f.OldContent != nil || f.NewContent != nil {
		t.Error("binary file should carry no blobs")
	}
	if !strings.Contains(res.Patch, "Binary files") {
		t.Errorf("patch should carry the binary stat line:\n%s", res.Patch)
	}
}

func TestEmptyDiff(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "content\n")
	commitAll(t, repo, "c1")

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if !res.Empty() {
		t.Errorf("expected empty capture, got %d files, patch %q", len(res.Files), res.Patch)
	}
}

func TestNoTrailingNewlineRoundTrips(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "with newline\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "no newline at end")

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "a.txt")
	if string(f.NewContent) != "no newline at end" {
		t.Errorf("content = %q", f.NewContent)
	}
	if !strings.Contains(res.Patch, "\\ No newline at end of file") {
		t.Errorf("patch missing no-newline marker:\n%s", res.Patch)
	}
}

func TestUntrackedFileAppearsAsAdded(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "tracked\n")
	commitAll(t, repo, "c1")
	write(t, repo, "brand-new.txt", "hello\nworld\n")
	write(t, repo, ".gitignore", "ignored.txt\n")
	write(t, repo, "ignored.txt", "should not appear\n")

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "brand-new.txt")
	if f == nil {
		t.Fatalf("untracked file missing: %+v", res.Files)
	}
	if f.Status != StatusAdded {
		t.Errorf("untracked status = %s, want added", f.Status)
	}
	if string(f.NewContent) != "hello\nworld\n" {
		t.Errorf("untracked content = %q", f.NewContent)
	}
	if fileByPath(res, "ignored.txt") != nil {
		t.Error("ignored file leaked into capture")
	}
	if !strings.Contains(res.Patch, "diff --git a/brand-new.txt b/brand-new.txt") ||
		!strings.Contains(res.Patch, "new file mode") ||
		!strings.Contains(res.Patch, "+hello") {
		t.Errorf("synthesized patch malformed:\n%s", res.Patch)
	}
}

func TestUntrackedExcludedFromStagedAndRangeCaptures(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "v2\n")
	commitAll(t, repo, "c2")
	write(t, repo, "untracked.txt", "x\n")

	for _, args := range [][]string{{"--staged"}, {"HEAD~1..HEAD"}} {
		res, err := Capture(repo, args)
		if err != nil {
			t.Fatalf("Capture %v: %v", args, err)
		}
		if fileByPath(res, "untracked.txt") != nil {
			t.Errorf("untracked file leaked into %v capture", args)
		}
	}
}

func TestFlagShapedArgRejected(t *testing.T) {
	repo := initRepo(t)
	for _, args := range [][]string{
		{"--ext-diff"},
		{"--output=/tmp/pwned"},
		{"-O/tmp/orderfile"},
		{"HEAD", "--no-index"},
	} {
		_, err := Capture(repo, args)
		if !errors.Is(err, ErrInvalidArg) {
			t.Errorf("Capture(%v): want ErrInvalidArg, got %v", args, err)
		}
	}

	// --staged, --cached, and post--- pathspecs pass validation.
	for _, args := range [][]string{
		{"--staged"},
		{"--cached"},
		{"--", "-strange-path"},
	} {
		if err := ValidateArgs(args); err != nil {
			t.Errorf("ValidateArgs(%v): unexpected %v", args, err)
		}
	}
}

func TestPathspecLimitsCapture(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "in/a.txt", "v1\n")
	write(t, repo, "out/b.txt", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "in/a.txt", "v2\n")
	write(t, repo, "out/b.txt", "v2\n")
	write(t, repo, "in/new.txt", "untracked in scope\n")
	write(t, repo, "out/new.txt", "untracked out of scope\n")

	res, err := Capture(repo, []string{"--", "in"})
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if fileByPath(res, "out/b.txt") != nil || fileByPath(res, "out/new.txt") != nil {
		t.Errorf("pathspec leaked out-of-scope files: %+v", res.Files)
	}
	if fileByPath(res, "in/a.txt") == nil || fileByPath(res, "in/new.txt") == nil {
		t.Errorf("in-scope files missing: %+v", res.Files)
	}
}

func symlink(t *testing.T, dir, target, path string) {
	t.Helper()
	if err := os.Symlink(target, filepath.Join(dir, path)); err != nil {
		t.Fatal(err)
	}
}

func TestUntrackedSymlinksCaptureAsLinkTargets(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "dir/f.txt", "v1\n")
	commitAll(t, repo, "c1")
	symlink(t, repo, "dir/f.txt", "file-link")
	symlink(t, repo, "dir", "dir-link")

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	for _, tc := range []struct{ path, target string }{
		{"file-link", "dir/f.txt"},
		{"dir-link", "dir"},
	} {
		f := fileByPath(res, tc.path)
		if f == nil || f.Status != StatusAdded || f.IsBinary || string(f.NewContent) != tc.target {
			t.Errorf("%s: got %+v, want added link to %q", tc.path, f, tc.target)
			continue
		}
		header := "diff --git a/" + tc.path + " b/" + tc.path + "\nnew file mode 120000\n"
		body := "\n+" + tc.target + "\n\\ No newline at end of file\n"
		if !strings.Contains(res.Patch, header) || !strings.Contains(res.Patch, body) {
			t.Errorf("%s: patch lacks the symlink entry:\n%s", tc.path, res.Patch)
		}
	}
}

func TestModifiedTrackedSymlinkReadsLinkTarget(t *testing.T) {
	repo := initRepo(t)
	write(t, repo, "a.txt", "a\n")
	write(t, repo, "b.txt", "b\n")
	symlink(t, repo, "a.txt", "link")
	commitAll(t, repo, "c1")
	if err := os.Remove(filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	symlink(t, repo, "b.txt", "link")

	res, err := Capture(repo, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "link")
	if f == nil || f.Status != StatusModified || string(f.OldContent) != "a.txt" || string(f.NewContent) != "b.txt" {
		t.Errorf("link: got %+v, want modified a.txt -> b.txt", f)
	}
}
