package gitx

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Head returns the commit HEAD points at and the branch checked out,
// with an empty branch on a detached HEAD. Both are empty before the
// first commit.
func Head(repoRoot string) (commit, branch string) {
	out, err := git(repoRoot, "rev-parse", "HEAD", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", ""
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", ""
	}
	commit, branch = lines[0], lines[1]
	if branch == "HEAD" {
		branch = ""
	}
	return commit, branch
}

// IsAncestor reports whether commit a is b or an ancestor of b. An
// unknown commit is an ancestor of nothing.
func IsAncestor(repoRoot, a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	_, err := git(repoRoot, "merge-base", "--is-ancestor", a, b)
	return err == nil
}

// BranchTip returns the commit a local branch points at, and whether
// the branch exists.
func BranchTip(repoRoot, branch string) (string, bool) {
	if branch == "" {
		return "", false
	}
	out, err := git(repoRoot, "rev-parse", "--verify", "-q", "refs/heads/"+branch)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// ResolveRef returns the commit a ref names, and whether it names one.
func ResolveRef(repoRoot, ref string) (string, bool) {
	if ref == "" {
		return "", false
	}
	out, err := git(repoRoot, "rev-parse", "--verify", "-q", ref+"^{commit}")
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// MergeBase returns the best common ancestor of two commits, "" when
// they have none.
func MergeBase(repoRoot, a, b string) string {
	if a == "" || b == "" {
		return ""
	}
	out, err := git(repoRoot, "merge-base", a, b)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// DefaultBranch names the branch work merges into: the remote's
// default when origin/HEAD is set, else main, else master. ref is what
// to compare commits against (origin/main tracks merges done on the
// host once fetched); name is the local branch name.
func DefaultBranch(repoRoot string) (ref, name string) {
	if out, err := git(repoRoot, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"); err == nil {
		ref = strings.TrimSpace(string(out))
		return ref, strings.TrimPrefix(ref, "origin/")
	}
	for _, b := range []string{"main", "master"} {
		if _, ok := BranchTip(repoRoot, b); ok {
			return b, b
		}
	}
	return "", ""
}

// IsWorkingTree reports whether a diff's new side is the working tree
// with no revision named, so a commit takes its hunks away.
func IsWorkingTree(args []string) bool { return isWorkingTreeCapture(args) }

// Commit is one line of a log.
type Commit struct {
	Hash    string    `json:"hash"`
	Subject string    `json:"subject"`
	Date    time.Time `json:"date"`
}

const logFormat = "--format=%H%x00%s%x00%aI"

// Log lists the commits of a revision range, newest first, at most
// limit of them.
func Log(repoRoot, revRange string, limit int) ([]Commit, error) {
	out, err := git(repoRoot, "log", logFormat, "-n", strconv.Itoa(limit), revRange, "--")
	if err != nil {
		return nil, err
	}
	return parseLog(out), nil
}

// Commits describes the listed commits in the order given, skipping the
// ones the repository does not have.
func Commits(repoRoot string, hashes []string) ([]Commit, error) {
	if len(hashes) == 0 {
		return nil, nil
	}
	args := append([]string{"log", "--no-walk=unsorted", "--ignore-missing", logFormat}, hashes...)
	out, err := git(repoRoot, append(args, "--")...)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil, nil
		}
		return nil, err
	}
	// With every hash missing, log falls back to HEAD: keep only what
	// was asked for.
	asked := make(map[string]bool, len(hashes))
	for _, h := range hashes {
		asked[h] = true
	}
	var commits []Commit
	for _, c := range parseLog(out) {
		if asked[c.Hash] {
			commits = append(commits, c)
		}
	}
	return commits, nil
}

func parseLog(out []byte) []Commit {
	var commits []Commit
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\x00")
		if len(parts) != 3 {
			continue
		}
		date, _ := time.Parse(time.RFC3339, parts[2])
		commits = append(commits, Commit{Hash: parts[0], Subject: parts[1], Date: date})
	}
	return commits
}
