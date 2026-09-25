// Package gitx captures git diffs: raw patch text plus per-file
// metadata and full old/new contents, ready to serve as a diff or to
// freeze as a thread's snapshot.
package gitx

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
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

	// Binary files keep where each side lives instead of its bytes: the
	// blob, or no blob when the new side is only in the working tree.
	OldOID, NewOID   string
	OldSize, NewSize int64
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

// forcedDiffFlags keep external diff drivers, textconv filters, and
// the user's rename setting out of every diff revue reads.
var forcedDiffFlags = []string{"--no-ext-diff", "--no-textconv", "--find-renames"}

func git(repoRoot string, args ...string) ([]byte, error) {
	return runGit(repoRoot, nil, false, args...)
}

// runGit runs git with the config overrides, feeding stdin when set.
// With exit1OK, exit status 1 is success: a --no-index diff uses it to
// mean "differences found".
func runGit(repoRoot string, stdin []byte, exit1OK bool, args ...string) ([]byte, error) {
	return runGitEnv(repoRoot, nil, stdin, exit1OK, args...)
}

// runGitEnv is runGit with variables added to the environment.
func runGitEnv(repoRoot string, env []string, stdin []byte, exit1OK bool, args ...string) ([]byte, error) {
	full := append(append([]string{}, configOverrides...), args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = repoRoot
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if exit1OK && errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return stdout.Bytes(), nil
		}
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// patchFlags make the diff whose output is the patch revue serves.
var patchFlags = append([]string{"--no-color", "--full-index"}, forcedDiffFlags...)

// runDiff runs git diff with flags on args.
func runDiff(repoRoot string, env []string, flags, args []string) ([]byte, error) {
	return runGitEnv(repoRoot, env, nil, false, append(append([]string{"diff"}, flags...), args...)...)
}

func isZeroOID(s string) bool { return strings.Trim(s, "0") == "" }

type rawEntry struct {
	oldOID, newOID string
	status         byte
	oldPath, path  string
}

// Capture turns a git-diff expression into patch text, file metadata,
// and old/new contents. Working-tree captures (no revisions, not
// staged) also include untracked non-ignored files, as added files or
// the new side of a rename.
// patch is the tracked-file patch Fingerprint returned for the same
// args; nil runs the diff here.
func Capture(repoRoot string, args []string, patch []byte) (*Result, error) {
	if err := ValidateArgs(args); err != nil {
		return nil, err
	}
	env, done, untracked, err := diffEnv(repoRoot, args)
	if err != nil {
		return nil, err
	}
	defer done()

	// The fingerprint's patch leaves untracked files out.
	if patch == nil || untracked {
		if patch, err = runDiff(repoRoot, env, patchFlags, args); err != nil {
			return nil, err
		}
	}

	listOut, err := runDiff(repoRoot, env, append([]string{"--raw", "--numstat", "-z", "--abbrev=64"}, forcedDiffFlags...), args)
	if err != nil {
		return nil, err
	}
	entries, binaryPaths, err := parseRawNumstatZ(listOut)
	if err != nil {
		return nil, err
	}

	files := make([]File, 0, len(entries))
	// Text sides are read whole, binary sides only sized: one cat-file
	// call each for the whole capture.
	var contentOIDs, sizeOIDs []string
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
		oids := &contentOIDs
		if f.IsBinary {
			oids = &sizeOIDs
		}
		if hasOldBlob(&f, e) {
			*oids = append(*oids, e.oldOID)
		}
		if f.Status != StatusDeleted && !isZeroOID(e.newOID) {
			*oids = append(*oids, e.newOID)
		}
		files = append(files, f)
	}
	contents, err := catFile(repoRoot, contentOIDs, true)
	if err != nil {
		return nil, err
	}
	sizes, err := catFile(repoRoot, sizeOIDs, false)
	if err != nil {
		return nil, err
	}
	for i, e := range entries {
		f := &files[i]
		if f.IsBinary {
			if err := binarySides(repoRoot, f, e, sizes); err != nil {
				return nil, err
			}
			continue
		}
		if hasOldBlob(f, e) {
			obj, ok := contents[e.oldOID]
			if !ok {
				return nil, fmt.Errorf("gitx: blob %s of %s is missing", e.oldOID, f.Path)
			}
			f.OldContent = obj.content
		}
		if f.Status == StatusDeleted {
			continue
		}
		// A new side git has no blob for is read from the working tree.
		if obj, ok := contents[e.newOID]; ok {
			f.NewContent = obj.content
		} else if f.NewContent, err = readWorktree(filepath.Join(repoRoot, e.path)); err != nil {
			return nil, err
		}
	}

	return &Result{Patch: joinTypeChanges(string(patch)), Files: files}, nil
}

// IgnoringSpace reads r's diff again with whitespace changes left out,
// as git diff -w prints it. hidden lists the files whose only changes
// were whitespace, which git -w leaves out.
func IgnoringSpace(repoRoot string, args []string, r *Result) (patch string, hidden map[string]bool, err error) {
	if err := ValidateArgs(args); err != nil {
		return "", nil, err
	}
	env, done, _, err := diffEnv(repoRoot, args)
	if err != nil {
		return "", nil, err
	}
	defer done()
	flags := append(append([]string{}, forcedDiffFlags...), "--ignore-all-space")
	out, err := runDiff(repoRoot, env, append([]string{"--no-color", "--full-index"}, flags...), args)
	if err != nil {
		return "", nil, err
	}
	names, err := runDiff(repoRoot, env, append([]string{"--name-only", "-z"}, flags...), args)
	if err != nil {
		return "", nil, err
	}
	kept := map[string]bool{}
	for _, name := range strings.Split(string(names), "\x00") {
		kept[name] = true
	}
	hidden = map[string]bool{}
	for _, f := range r.Files {
		if !kept[f.Path] {
			hidden[f.Path] = true
		}
	}
	return joinTypeChanges(string(out)), hidden, nil
}

func hasOldBlob(f *File, e rawEntry) bool {
	return f.Status != StatusAdded && !isZeroOID(e.oldOID)
}

// binarySides records the blob and byte size of each side of a binary
// file, so a side can be served later without holding it in memory.
func binarySides(repoRoot string, f *File, e rawEntry, sizes map[string]object) error {
	if hasOldBlob(f, e) {
		obj, ok := sizes[e.oldOID]
		if !ok {
			return fmt.Errorf("gitx: blob %s of %s is missing", e.oldOID, f.Path)
		}
		f.OldOID, f.OldSize = e.oldOID, obj.size
	}
	if f.Status == StatusDeleted {
		return nil
	}
	if obj, ok := sizes[e.newOID]; ok {
		f.NewOID, f.NewSize = e.newOID, obj.size
		return nil
	}
	info, err := os.Lstat(filepath.Join(repoRoot, f.Path))
	if err != nil {
		return err
	}
	f.NewSize = info.Size()
	return nil
}

// object is one blob read by catFile; content is nil for a size-only
// read.
type object struct {
	size    int64
	content []byte
}

// catFile reads blobs with one `git cat-file` call: whole contents with
// --batch, sizes only with --batch-check. Objects that are missing or
// not blobs are absent from the result.
func catFile(repoRoot string, oids []string, contents bool) (map[string]object, error) {
	objs := map[string]object{}
	if len(oids) == 0 {
		return objs, nil
	}
	oids = slices.Compact(slices.Sorted(slices.Values(oids)))
	mode := "--batch-check"
	if contents {
		mode = "--batch"
	}
	out, err := runGit(repoRoot, []byte(strings.Join(oids, "\n")+"\n"), false, "cat-file", mode)
	if err != nil {
		return nil, err
	}
	// Each frame is "<oid> <type> <size>\n", followed with --batch by
	// the content and a newline; an unknown name is "<oid> missing\n".
	for len(out) > 0 {
		header, rest, ok := bytes.Cut(out, []byte("\n"))
		if !ok {
			return nil, fmt.Errorf("gitx: truncated cat-file header %q", header)
		}
		out = rest
		fields := strings.Fields(string(header))
		if len(fields) == 2 {
			continue // missing or ambiguous
		}
		if len(fields) != 3 {
			return nil, fmt.Errorf("gitx: unexpected cat-file header %q", header)
		}
		size, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("gitx: unexpected cat-file header %q", header)
		}
		obj := object{size: size}
		if contents {
			if int64(len(out)) < size+1 {
				return nil, fmt.Errorf("gitx: truncated cat-file content for %s", fields[0])
			}
			obj.content = out[:size:size]
			out = out[size+1:]
		}
		if fields[1] == "blob" {
			objs[fields[0]] = obj
		}
	}
	return objs, nil
}

// ReadSide returns one side of a captured file: the old side from its
// blob, the new side from its blob or, when it has none, from the
// working tree.
func ReadSide(repoRoot string, f *File, old bool) ([]byte, error) {
	if old {
		if f.OldOID == "" {
			return nil, os.ErrNotExist
		}
		return git(repoRoot, "cat-file", "blob", f.OldOID)
	}
	if f.Status == StatusDeleted {
		return nil, os.ErrNotExist
	}
	return newSideContent(repoRoot, f.NewOID, f.Path)
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
	return readWorktree(filepath.Join(repoRoot, path))
}

// WorktreeContent reads path in the working tree the way git stores it.
func WorktreeContent(repoRoot, path string) ([]byte, error) {
	return readWorktree(filepath.Join(repoRoot, filepath.FromSlash(path)))
}

// readWorktree reads a path the way git stores it: a symlink's blob is
// its target, not the file it points to.
func readWorktree(full string) ([]byte, error) {
	info, err := os.Lstat(full)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(full)
		if err != nil {
			return nil, err
		}
		return []byte(target), nil
	}
	return os.ReadFile(full)
}

// isWorkingTreeCapture reports whether the diff's new side is the
// working tree with no revision pinned: only then do untracked files
// belong in the diff.
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

// joinTypeChanges rewrites each type change (a file that became a
// symlink, or the reverse) as one section. git prints it as a deletion
// followed by an addition of the same path, which the raw listing
// reports as one entry; one section per path keeps the patch and the
// file list in step.
func joinTypeChanges(patch string) string {
	sections := splitSections(patch)
	var b strings.Builder
	for i := 0; i < len(sections); i++ {
		if i+1 < len(sections) {
			if joined, ok := joinTypeChange(sections[i], sections[i+1]); ok {
				b.WriteString(joined)
				i++
				continue
			}
		}
		b.WriteString(sections[i])
	}
	return b.String()
}

// splitSections cuts a patch at each "diff --git " line. Content lines
// carry a +, - or space prefix, so they never match.
func splitSections(patch string) []string {
	var sections []string
	start := 0
	for i := 0; i < len(patch); {
		if i > start && strings.HasPrefix(patch[i:], "diff --git ") {
			sections = append(sections, patch[start:i])
			start = i
		}
		nl := strings.IndexByte(patch[i:], '\n')
		if nl < 0 {
			break
		}
		i += nl + 1
	}
	if start < len(patch) {
		sections = append(sections, patch[start:])
	}
	return sections
}

type patchSection struct {
	header, mode, oid string
	fromLine, toLine  string
	binary            string
	hunkRange         []string
	body              string
}

// parseSection reads a whole-file section: a deletion or an addition,
// with at most one hunk.
func parseSection(s string) patchSection {
	var p patchSection
	lines := strings.SplitAfter(s, "\n")
	p.header = lines[0]
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		switch {
		case strings.HasPrefix(line, "deleted file mode "):
			p.mode = strings.TrimSpace(strings.TrimPrefix(line, "deleted file mode "))
		case strings.HasPrefix(line, "new file mode "):
			p.mode = strings.TrimSpace(strings.TrimPrefix(line, "new file mode "))
		case strings.HasPrefix(line, "index "):
			p.oid = strings.TrimSpace(strings.TrimPrefix(line, "index "))
		case strings.HasPrefix(line, "--- "):
			p.fromLine = line
		case strings.HasPrefix(line, "+++ "):
			p.toLine = line
		case strings.HasPrefix(line, "Binary files "):
			p.binary = line
		case strings.HasPrefix(line, "@@ "):
			p.hunkRange = strings.Fields(line)[1:3]
			p.body = strings.Join(lines[i+1:], "")
			return p
		}
	}
	return p
}

// joinTypeChange merges a deletion and the addition that follows it
// into one section with old and new modes, the way git prints a mode
// change, and one hunk that replaces the old content with the new.
func joinTypeChange(first, second string) (string, bool) {
	del, add := parseSection(first), parseSection(second)
	if del.header != add.header ||
		!strings.Contains(first, "\ndeleted file mode ") ||
		!strings.Contains(second, "\nnew file mode ") {
		return "", false
	}
	oldOID, _, _ := strings.Cut(del.oid, "..")
	_, newOID, _ := strings.Cut(add.oid, "..")

	var b strings.Builder
	b.WriteString(del.header)
	fmt.Fprintf(&b, "old mode %s\nnew mode %s\nindex %s..%s\n", del.mode, add.mode, oldOID, newOID)
	if del.binary != "" || add.binary != "" {
		b.WriteString("Binary files differ\n")
		return b.String(), true
	}
	if del.hunkRange == nil && add.hunkRange == nil {
		return b.String(), true
	}
	b.WriteString(del.fromLine)
	b.WriteString(add.toLine)
	oldRange, newRange := "-0,0", "+0,0"
	if del.hunkRange != nil {
		oldRange = del.hunkRange[0]
	}
	if add.hunkRange != nil {
		newRange = add.hunkRange[1]
	}
	fmt.Fprintf(&b, "@@ %s %s @@\n", oldRange, newRange)
	b.WriteString(del.body)
	b.WriteString(add.body)
	return b.String(), true
}

// parseRawNumstatZ parses `git diff --raw --numstat -z` output: every
// raw entry first, then every numstat entry. It returns the raw entries
// and the set of paths numstat reports as binary.
func parseRawNumstatZ(out []byte) ([]rawEntry, map[string]bool, error) {
	fields := strings.Split(string(out), "\x00")
	entries, rest, err := parseRawZ(fields)
	if err != nil {
		return nil, nil, err
	}
	return entries, parseNumstatBinaries(rest), nil
}

// parseRawZ parses the raw entries at the start of fields:
// :oldmode newmode oldsha newsha status\0path\0  (or \0old\0new\0 for R/C)
// and returns the fields after them.
func parseRawZ(fields []string) ([]rawEntry, []string, error) {
	var entries []rawEntry
	i := 0
	for i < len(fields) {
		meta := fields[i]
		if !strings.HasPrefix(meta, ":") {
			break
		}
		parts := strings.Fields(meta[1:])
		if len(parts) < 5 {
			return nil, nil, fmt.Errorf("gitx: short raw entry %q", meta)
		}
		e := rawEntry{oldOID: parts[2], newOID: parts[3], status: parts[4][0]}
		switch e.status {
		case 'R', 'C':
			if i+2 >= len(fields) {
				return nil, nil, fmt.Errorf("gitx: truncated rename entry %q", meta)
			}
			e.oldPath, e.path = fields[i+1], fields[i+2]
			i += 3
		default:
			if i+1 >= len(fields) {
				return nil, nil, fmt.Errorf("gitx: truncated entry %q", meta)
			}
			e.path = fields[i+1]
			i += 2
		}
		entries = append(entries, e)
	}
	return entries, fields[i:], nil
}

// parseNumstatBinaries returns the set of paths git reports as binary
// ("-" line counts) in `git diff --numstat -z` fields.
func parseNumstatBinaries(fields []string) map[string]bool {
	binaries := map[string]bool{}
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

// Fingerprint identifies the state a Capture of args would see, at a
// fraction of its cost: the raw patch git prints for tracked files, plus
// the untracked files with their sizes and mtimes when the working tree
// is the new side. Two equal fingerprints mean nothing changed for this
// diff. The patch is returned too, for Capture to reuse when there are
// no untracked files.
func Fingerprint(repoRoot string, args []string) (string, []byte, error) {
	if err := ValidateArgs(args); err != nil {
		return "", nil, err
	}
	var env []string
	if isCheckpointCapture(args) {
		var done func()
		var err error
		if env, done, err = checkpointEnv(repoRoot); err != nil {
			return "", nil, err
		}
		defer done()
	}
	h := sha256.New()
	patch, err := runDiff(repoRoot, env, patchFlags, args)
	if err != nil {
		return "", nil, err
	}
	h.Write(patch)
	if isWorkingTreeCapture(args) {
		files, err := listUntracked(repoRoot, pathspecs(args))
		if err != nil {
			return "", nil, err
		}
		for _, p := range files {
			info, err := os.Lstat(filepath.Join(repoRoot, p))
			if err != nil {
				continue // vanished between the listing and the stat
			}
			_, _ = fmt.Fprintf(h, "\x00%s\x00%d\x00%d", p, info.Size(), info.ModTime().UnixNano())
		}
	}
	return hex.EncodeToString(h.Sum(nil)), patch, nil
}

// Branch names the checked-out branch, or "HEAD" when detached.
func Branch(repoRoot string) string {
	out, err := git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// RepoName names the repository after its origin remote, so a checkout
// in a generic directory such as a container's /workspace still reads
// as the project. Without an origin, the directory name stands in.
func RepoName(repoRoot string) string {
	out, err := git(repoRoot, "remote", "get-url", "origin")
	if err == nil {
		url := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(string(out)), "/"), ".git")
		if i := strings.LastIndexAny(url, "/:"); i >= 0 && i < len(url)-1 {
			return url[i+1:]
		}
	}
	return filepath.Base(repoRoot)
}
