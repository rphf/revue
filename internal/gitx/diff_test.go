package gitx

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rphf/revue/internal/gittest"
)

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
	gittest.Git(t, dir, "add", "-A")
	gittest.Git(t, dir, "commit", "-q", "-m", msg)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\ntwo\nthree\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "one\nTWO\nthree\n")

	res, err := Capture(repo, nil, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "v2\n")
	gittest.Git(t, repo, "add", "a.txt")
	// A further unstaged edit must NOT appear in a staged capture.
	write(t, repo, "a.txt", "v3-unstaged\n")

	res, err := Capture(repo, []string{"--staged"}, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "first\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "second\n")
	commitAll(t, repo, "c2")
	// Worktree noise must not leak into a range capture.
	write(t, repo, "a.txt", "worktree-noise\n")

	res, err := Capture(repo, []string{"HEAD~1..HEAD"}, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "base\n")
	commitAll(t, repo, "c1")
	gittest.Git(t, repo, "checkout", "-q", "-b", "feature")
	write(t, repo, "a.txt", "feature-change\n")
	commitAll(t, repo, "c2")
	gittest.Git(t, repo, "checkout", "-q", "main")

	res, err := Capture(repo, []string{"main..feature"}, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "a.txt")
	if f == nil || string(f.NewContent) != "feature-change\n" {
		t.Fatalf("branch diff wrong: %+v", f)
	}
}

func TestRenameWithUnchangedContentCarriesMetadata(t *testing.T) {
	repo := gittest.Init(t)
	content := strings.Repeat("stable line\n", 20)
	write(t, repo, "old/name.txt", content)
	commitAll(t, repo, "c1")
	if err := os.MkdirAll(filepath.Join(repo, "new"), 0o755); err != nil {
		t.Fatal(err)
	}
	gittest.Git(t, repo, "mv", "old/name.txt", "new/name.txt")
	commitAll(t, repo, "c2")

	res, err := Capture(repo, []string{"HEAD~1..HEAD"}, nil)
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
	repo := gittest.Init(t)
	if err := os.WriteFile(filepath.Join(repo, "img.dat"), []byte{0x00, 0x01, 0xFF, 0xFE}, 0o644); err != nil {
		t.Fatal(err)
	}
	commitAll(t, repo, "c1")
	if err := os.WriteFile(filepath.Join(repo, "img.dat"), []byte{0x00, 0xAA, 0xBB}, 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := Capture(repo, nil, nil)
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
	if f.OldSize != 4 || f.NewSize != 3 || f.OldOID == "" || f.NewOID != "" {
		t.Errorf("sides: old %d %q, new %d %q; want 4 bytes in a blob, 3 on disk", f.OldSize, f.OldOID, f.NewSize, f.NewOID)
	}

	commitAll(t, repo, "c2")
	res, err = Capture(repo, []string{"HEAD~1..HEAD"}, nil)
	if err != nil {
		t.Fatalf("Capture range: %v", err)
	}
	f = fileByPath(res, "img.dat")
	if f == nil || f.NewOID == "" {
		t.Fatalf("range: got %+v, want the new side in a blob", f)
	}
	for _, side := range []struct {
		old  bool
		want []byte
	}{{true, []byte{0x00, 0x01, 0xFF, 0xFE}}, {false, []byte{0x00, 0xAA, 0xBB}}} {
		got, err := ReadSide(repo, f, side.old)
		if err != nil || !bytes.Equal(got, side.want) {
			t.Errorf("ReadSide(old=%v) = %v, %v; want %v", side.old, got, err, side.want)
		}
	}
}

func TestEmptyDiff(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "content\n")
	commitAll(t, repo, "c1")

	res, err := Capture(repo, nil, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if !res.Empty() {
		t.Errorf("expected empty capture, got %d files, patch %q", len(res.Files), res.Patch)
	}
}

func TestNoTrailingNewlineRoundTrips(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "with newline\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "no newline at end")

	res, err := Capture(repo, nil, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "tracked\n")
	commitAll(t, repo, "c1")
	write(t, repo, "brand-new.txt", "hello\nworld\n")
	write(t, repo, ".gitignore", "ignored.txt\n")
	write(t, repo, "ignored.txt", "should not appear\n")

	res, err := Capture(repo, nil, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "a.txt", "v2\n")
	commitAll(t, repo, "c2")
	write(t, repo, "untracked.txt", "x\n")

	for _, args := range [][]string{{"--staged"}, {"HEAD~1..HEAD"}} {
		res, err := Capture(repo, args, nil)
		if err != nil {
			t.Fatalf("Capture %v: %v", args, err)
		}
		if fileByPath(res, "untracked.txt") != nil {
			t.Errorf("untracked file leaked into %v capture", args)
		}
	}
}

func TestFlagShapedArgRejected(t *testing.T) {
	repo := gittest.Init(t)
	for _, args := range [][]string{
		{"--ext-diff"},
		{"--output=/tmp/pwned"},
		{"-O/tmp/orderfile"},
		{"HEAD", "--no-index"},
	} {
		_, err := Capture(repo, args, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "in/a.txt", "v1\n")
	write(t, repo, "out/b.txt", "v1\n")
	commitAll(t, repo, "c1")
	write(t, repo, "in/a.txt", "v2\n")
	write(t, repo, "out/b.txt", "v2\n")
	write(t, repo, "in/new.txt", "untracked in scope\n")
	write(t, repo, "out/new.txt", "untracked out of scope\n")

	res, err := Capture(repo, []string{"--", "in"}, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "dir/f.txt", "v1\n")
	commitAll(t, repo, "c1")
	symlink(t, repo, "dir/f.txt", "file-link")
	symlink(t, repo, "dir", "dir-link")

	res, err := Capture(repo, nil, nil)
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
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "a\n")
	write(t, repo, "b.txt", "b\n")
	symlink(t, repo, "a.txt", "link")
	commitAll(t, repo, "c1")
	if err := os.Remove(filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	symlink(t, repo, "b.txt", "link")

	res, err := Capture(repo, nil, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	f := fileByPath(res, "link")
	if f == nil || f.Status != StatusModified || string(f.OldContent) != "a.txt" || string(f.NewContent) != "b.txt" {
		t.Errorf("link: got %+v, want modified a.txt -> b.txt", f)
	}
}

func TestFingerprintFollowsTrackedAndUntrackedChanges(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "one\ntwo\n")
	commitAll(t, repo, "c1")
	fp1, _, err := Fingerprint(repo, nil)
	if err != nil {
		t.Fatal(err)
	}
	fp1b, _, _ := Fingerprint(repo, nil)
	if fp1 != fp1b {
		t.Fatal("fingerprint not stable on an unchanged tree")
	}

	write(t, repo, "a.txt", "changed\n")
	fp2, _, _ := Fingerprint(repo, nil)
	if fp2 == fp1 {
		t.Error("tracked edit did not move the fingerprint")
	}

	write(t, repo, "new.txt", "hello\n")
	fp3, _, _ := Fingerprint(repo, nil)
	if fp3 == fp2 {
		t.Error("untracked file did not move the fingerprint")
	}

	// The untracked file is not part of a staged capture.
	s1, _, _ := Fingerprint(repo, []string{"--staged"})
	write(t, repo, "new.txt", "hello again\n")
	s2, _, _ := Fingerprint(repo, []string{"--staged"})
	if s1 != s2 {
		t.Error("staged fingerprint moved on an untracked edit")
	}

	if _, _, err := Fingerprint(repo, []string{"--ext-diff"}); !errors.Is(err, ErrInvalidArg) {
		t.Errorf("flag arg err = %v, want ErrInvalidArg", err)
	}
	if Branch(repo) != "main" {
		t.Errorf("Branch = %q, want main", Branch(repo))
	}
}

func TestTypeChangeIsOneSection(t *testing.T) {
	for _, tc := range []struct {
		name, oldMode, newMode string
		setup, change          func(t *testing.T, repo string)
		oldContent, newContent string
		body                   string
	}{
		{
			name: "file to symlink", oldMode: "100644", newMode: "120000",
			setup: func(t *testing.T, repo string) { write(t, repo, "notes.md", "one\ntwo\n") },
			change: func(t *testing.T, repo string) {
				if err := os.Remove(filepath.Join(repo, "notes.md")); err != nil {
					t.Fatal(err)
				}
				symlink(t, repo, "a.txt", "notes.md")
			},
			oldContent: "one\ntwo\n", newContent: "a.txt",
			body: "@@ -1,2 +1 @@\n-one\n-two\n+a.txt\n\\ No newline at end of file\n",
		},
		{
			name: "symlink to file", oldMode: "120000", newMode: "100644",
			setup: func(t *testing.T, repo string) { symlink(t, repo, "a.txt", "notes.md") },
			change: func(t *testing.T, repo string) {
				if err := os.Remove(filepath.Join(repo, "notes.md")); err != nil {
					t.Fatal(err)
				}
				write(t, repo, "notes.md", "one\ntwo\n")
			},
			oldContent: "a.txt", newContent: "one\ntwo\n",
			body: "@@ -1 +1,2 @@\n-a.txt\n\\ No newline at end of file\n+one\n+two\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := gittest.Init(t)
			write(t, repo, "a.txt", "a\n")
			tc.setup(t, repo)
			commitAll(t, repo, "c1")
			tc.change(t, repo)

			res, err := Capture(repo, nil, nil)
			if err != nil {
				t.Fatalf("Capture: %v", err)
			}
			if n := strings.Count(res.Patch, "diff --git a/notes.md b/notes.md\n"); n != 1 {
				t.Fatalf("got %d sections for notes.md, want 1:\n%s", n, res.Patch)
			}
			modes := "old mode " + tc.oldMode + "\nnew mode " + tc.newMode + "\n"
			paths := "--- a/notes.md\n+++ b/notes.md\n" + tc.body
			if !strings.Contains(res.Patch, modes) || !strings.Contains(res.Patch, paths) {
				t.Errorf("patch lacks the joined section:\n%s", res.Patch)
			}
			f := fileByPath(res, "notes.md")
			if f == nil || f.Status != StatusModified || string(f.OldContent) != tc.oldContent || string(f.NewContent) != tc.newContent {
				t.Errorf("notes.md: got %+v, want modified", f)
			}
		})
	}
}

func TestRepoNameFollowsOrigin(t *testing.T) {
	repo := gittest.Init(t)
	if got, want := RepoName(repo), filepath.Base(repo); got != want {
		t.Errorf("without origin: got %q, want %q", got, want)
	}
	gittest.Git(t, repo, "remote", "add", "origin", "https://example.com/placeholder")
	for _, url := range []string{
		"git@github.com:rphf/revue.git",
		"https://github.com/rphf/revue.git",
		"https://github.com/rphf/revue/",
		"/srv/git/revue",
	} {
		gittest.Git(t, repo, "remote", "set-url", "origin", url)
		if got := RepoName(repo); got != "revue" {
			t.Errorf("%s: got %q, want revue", url, got)
		}
	}
}

// One capture mixing every kind of entry: the raw and numstat records
// share one listing, and every blob comes from one cat-file call.
func TestMixedCaptureReadsEveryFile(t *testing.T) {
	repo := gittest.Init(t)
	long := strings.Repeat("line\n", 40)
	write(t, repo, "moved.txt", long)
	write(t, repo, "gone.txt", "bye\n")
	write(t, repo, "same.txt", "one\n")
	write(t, repo, "empty.txt", "")
	if err := os.WriteFile(filepath.Join(repo, "img.bin"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatal(err)
	}
	commitAll(t, repo, "c1")

	gittest.Git(t, repo, "mv", "moved.txt", "renamed.txt")
	write(t, repo, "renamed.txt", long+"tail\n")
	gittest.Git(t, repo, "rm", "-q", "gone.txt")
	write(t, repo, "same.txt", "two\n")
	write(t, repo, "empty.txt", "filled\n")
	if err := os.WriteFile(filepath.Join(repo, "img.bin"), []byte{0, 9}, 0o644); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "fresh.txt", "new\n")
	gittest.Git(t, repo, "add", "-A")

	fp, patch, err := Fingerprint(repo, []string{"--staged"})
	if err != nil || fp == "" {
		t.Fatalf("Fingerprint: %q, %v", fp, err)
	}
	reused, err := Capture(repo, []string{"--staged"}, patch)
	if err != nil {
		t.Fatalf("Capture with patch: %v", err)
	}
	res, err := Capture(repo, []string{"--staged"}, nil)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if reused.Patch != res.Patch || len(reused.Files) != len(res.Files) {
		t.Errorf("a reused patch changed the capture")
	}

	want := map[string]struct {
		status, oldPath, oldContent, newContent string
		binary                                  bool
	}{
		"renamed.txt": {StatusRenamed, "moved.txt", long, long + "tail\n", false},
		"gone.txt":    {StatusDeleted, "", "bye\n", "", false},
		"same.txt":    {StatusModified, "", "one\n", "two\n", false},
		"empty.txt":   {StatusModified, "", "", "filled\n", false},
		"fresh.txt":   {StatusAdded, "", "", "new\n", false},
		"img.bin":     {StatusModified, "", "", "", true},
	}
	if len(res.Files) != len(want) {
		t.Fatalf("files = %+v", res.Files)
	}
	for path, w := range want {
		f := fileByPath(res, path)
		if f == nil {
			t.Errorf("%s missing", path)
			continue
		}
		if f.Status != w.status || f.OldPath != w.oldPath || f.IsBinary != w.binary ||
			string(f.OldContent) != w.oldContent || string(f.NewContent) != w.newContent {
			t.Errorf("%s = %+v", path, f)
		}
	}
	if f := fileByPath(res, "empty.txt"); f.OldContent == nil {
		t.Error("an empty old side must read as empty, not absent")
	}
	if f := fileByPath(res, "gone.txt"); f.NewContent != nil {
		t.Error("a deleted file has no new side")
	}
	if f := fileByPath(res, "img.bin"); f.OldSize != 3 || f.NewSize != 2 || f.OldOID == "" || f.NewOID == "" {
		t.Errorf("binary sides = %+v", f)
	}
}

func TestCatFileSkipsMissingObjects(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, "a.txt", "hello\n")
	commitAll(t, repo, "c1")
	oid := strings.TrimSpace(gittest.Git(t, repo, "rev-parse", "HEAD:a.txt"))
	missing := strings.Repeat("1", len(oid))
	commit := strings.TrimSpace(gittest.Git(t, repo, "rev-parse", "HEAD"))

	objs, err := catFile(repo, []string{oid, missing, oid, commit}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(objs) != 1 || string(objs[oid].content) != "hello\n" || objs[oid].size != 6 {
		t.Errorf("contents = %+v", objs)
	}
	sizes, err := catFile(repo, []string{missing, oid}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(sizes) != 1 || sizes[oid].size != 6 || sizes[oid].content != nil {
		t.Errorf("sizes = %+v", sizes)
	}
}
