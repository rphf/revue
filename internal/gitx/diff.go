// Package gitx captures git diffs: raw patch text plus per-file
// metadata and full old/new contents, ready to freeze as a round.
package gitx

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// File statuses, aligned with store.File*.
const (
	StatusAdded    = "added"
	StatusModified = "modified"
	StatusDeleted  = "deleted"
	StatusRenamed  = "renamed"
)

// ErrInvalidArg rejects flag-shaped passthrough arguments so
// --ext-diff/--output-style injection never reaches git.
var ErrInvalidArg = errors.New("invalid diff argument")

type File struct {
	Path       string
	OldPath    string // set when Status == renamed
	Status     string
	IsBinary   bool
	OldContent []byte // nil for added or binary files
	NewContent []byte // nil for deleted or binary files
}

type Result struct {
	Patch string
	Files []File
}

// Empty reports whether the capture contains no changes.
func (r *Result) Empty() bool { return len(r.Files) == 0 && strings.TrimSpace(r.Patch) == "" }

// allowedFlags are the only flag-shaped passthrough tokens accepted
// before a bare "--"; everything after "--" is a pathspec to git.
var allowedFlags = map[string]bool{
	"--staged": true,
	"--cached": true,
}

// ValidateArgs enforces the passthrough policy: revision specs and
// paths only, plus the small allowlist above.
func ValidateArgs(args []string) error {
	for _, a := range args {
		if a == "--" {
			break
		}
		if strings.HasPrefix(a, "-") && !allowedFlags[a] {
			return fmt.Errorf("%w: %q (flags are not passed through; use -- to separate paths)", ErrInvalidArg, a)
		}
	}
	return nil
}

// configOverrides pin diff output to the canonical format regardless
// of user git config.
var configOverrides = []string{
	"-c", "color.diff=never",
	"-c", "diff.noprefix=false",
	"-c", "diff.mnemonicPrefix=false",
	"-c", "core.quotepath=false",
}

func git(repoRoot string, args ...string) ([]byte, error) {
	full := append(append([]string{}, configOverrides...), args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = repoRoot
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// gitDiffExit1OK runs a git diff variant where exit status 1 just
// means "differences found".
func gitDiffExit1OK(repoRoot string, args ...string) ([]byte, error) {
	full := append(append([]string{}, configOverrides...), args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = repoRoot
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return stdout.Bytes(), nil
		}
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func isZeroOID(s string) bool {
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return true
}

type rawEntry struct {
	oldOID, newOID string
	status         byte
	oldPath, path  string
}

// Capture turns a git-diff expression into patch text, file metadata,
// and old/new contents. Working-tree captures (no revisions, not
// staged) also include untracked non-ignored files as added files.
func Capture(repoRoot string, args []string) (*Result, error) {
	if err := ValidateArgs(args); err != nil {
		return nil, err
	}

	forced := []string{"--no-ext-diff", "--no-textconv", "--find-renames"}
	patchArgs := append(append([]string{"diff", "--no-color", "--full-index"}, forced...), args...)
	patchOut, err := git(repoRoot, patchArgs...)
	if err != nil {
		return nil, err
	}

	rawArgs := append(append([]string{"diff", "--raw", "-z", "--abbrev=64"}, forced...), args...)
	rawOut, err := git(repoRoot, rawArgs...)
	if err != nil {
		return nil, err
	}
	entries, err := parseRawZ(rawOut)
	if err != nil {
		return nil, err
	}

	numstatArgs := append(append([]string{"diff", "--numstat", "-z"}, forced...), args...)
	numstatOut, err := git(repoRoot, numstatArgs...)
	if err != nil {
		return nil, err
	}
	binaryPaths := parseNumstatBinaries(numstatOut)

	var files []File
	for _, e := range entries {
		f := File{Path: e.path, OldPath: e.oldPath, IsBinary: binaryPaths[e.path]}
		switch e.status {
		case 'A':
			f.Status = StatusAdded
		case 'D':
			f.Status = StatusDeleted
		case 'R':
			f.Status = StatusRenamed
		case 'C':
			// Copies present as added files; the source is untouched.
			f.Status = StatusAdded
			f.OldPath = ""
		default: // M, T, and anything exotic
			f.Status = StatusModified
		}
		if !f.IsBinary {
			if f.Status != StatusAdded && !isZeroOID(e.oldOID) {
				content, err := git(repoRoot, "cat-file", "blob", e.oldOID)
				if err != nil {
					return nil, err
				}
				f.OldContent = content
			}
			if f.Status != StatusDeleted {
				f.NewContent, err = newSideContent(repoRoot, e.newOID, e.path)
				if err != nil {
					return nil, err
				}
			}
		}
		files = append(files, f)
	}

	patch := string(patchOut)

	if isWorkingTreeCapture(args) {
		untracked, upatch, err := captureUntracked(repoRoot, pathspecs(args))
		if err != nil {
			return nil, err
		}
		files = append(files, untracked...)
		patch += upatch
	}

	return &Result{Patch: patch, Files: files}, nil
}

// newSideContent reads the post-image: from the object database when
// the OID is real (commit or index side), from the working tree when
// git reported a zero/unstored OID.
func newSideContent(repoRoot, oid, path string) ([]byte, error) {
	if !isZeroOID(oid) {
		if content, err := git(repoRoot, "cat-file", "blob", oid); err == nil {
			return content, nil
		}
	}
	return os.ReadFile(filepath.Join(repoRoot, path))
}

// isWorkingTreeCapture reports whether the diff's new side is the
// working tree with no revision pinned: only then do untracked files
// belong in the review (R1).
func isWorkingTreeCapture(args []string) bool {
	// Anything before a bare "--" pins a side: --staged makes the index
	// the new side, a revision makes the old side a commit.
	return len(args) == 0 || args[0] == "--"
}

// pathspecs extracts everything after a bare "--".
func pathspecs(args []string) []string {
	for i, a := range args {
		if a == "--" {
			return args[i+1:]
		}
	}
	return nil
}

// captureUntracked enumerates untracked non-ignored files and
// synthesizes added-file patches for them via git diff --no-index.
func captureUntracked(repoRoot string, paths []string) ([]File, string, error) {
	lsArgs := []string{"ls-files", "--others", "--exclude-standard", "-z"}
	if len(paths) > 0 {
		lsArgs = append(lsArgs, "--")
		lsArgs = append(lsArgs, paths...)
	}
	out, err := git(repoRoot, lsArgs...)
	if err != nil {
		return nil, "", err
	}
	var files []File
	var patch strings.Builder
	for _, p := range strings.Split(string(out), "\x00") {
		if p == "" {
			continue
		}
		numstat, err := gitDiffExit1OK(repoRoot, "diff", "--no-index", "--no-ext-diff", "--numstat", "--", os.DevNull, p)
		if err != nil {
			return nil, "", err
		}
		isBinary := strings.HasPrefix(strings.TrimSpace(string(numstat)), "-\t-\t")

		filePatch, err := gitDiffExit1OK(repoRoot, "diff", "--no-index", "--no-ext-diff", "--no-color", "--full-index", "--", os.DevNull, p)
		if err != nil {
			return nil, "", err
		}
		patch.Write(filePatch)

		f := File{Path: p, Status: StatusAdded, IsBinary: isBinary}
		if !isBinary {
			content, err := os.ReadFile(filepath.Join(repoRoot, p))
			if err != nil {
				return nil, "", err
			}
			f.NewContent = content
		}
		files = append(files, f)
	}
	return files, patch.String(), nil
}

// parseRawZ parses `git diff --raw -z` output:
// :oldmode newmode oldsha newsha status\0path\0  (or \0old\0new\0 for R/C)
func parseRawZ(out []byte) ([]rawEntry, error) {
	fields := strings.Split(string(out), "\x00")
	var entries []rawEntry
	for i := 0; i < len(fields); {
		meta := fields[i]
		if meta == "" {
			break
		}
		if !strings.HasPrefix(meta, ":") {
			return nil, fmt.Errorf("gitx: unexpected raw entry %q", meta)
		}
		parts := strings.Fields(meta[1:])
		if len(parts) < 5 {
			return nil, fmt.Errorf("gitx: short raw entry %q", meta)
		}
		e := rawEntry{oldOID: parts[2], newOID: parts[3], status: parts[4][0]}
		switch e.status {
		case 'R', 'C':
			if i+2 >= len(fields) {
				return nil, fmt.Errorf("gitx: truncated rename entry %q", meta)
			}
			e.oldPath, e.path = fields[i+1], fields[i+2]
			i += 3
		default:
			if i+1 >= len(fields) {
				return nil, fmt.Errorf("gitx: truncated entry %q", meta)
			}
			e.path = fields[i+1]
			i += 2
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// parseNumstatBinaries returns the set of paths git reports as binary
// ("-" line counts) in `git diff --numstat -z` output.
func parseNumstatBinaries(out []byte) map[string]bool {
	binaries := map[string]bool{}
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); {
		entry := fields[i]
		if entry == "" {
			break
		}
		parts := strings.SplitN(entry, "\t", 3)
		if len(parts) < 3 {
			break
		}
		isBinary := parts[0] == "-" && parts[1] == "-"
		path := parts[2]
		if path == "" {
			// Rename: -z emits "add\tdel\t\0old\0new\0".
			if i+2 >= len(fields) {
				break
			}
			path = fields[i+2]
			i += 3
		} else {
			i++
		}
		if isBinary {
			binaries[path] = true
		}
	}
	return binaries
}
