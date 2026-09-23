// Package anchor places comment threads in a diff. A thread remembers
// where it was written (path, side, line, the hash and start of its
// hunk, the file side's content hash); Locate maps that origin into any
// later capture by normalized hunk content, rename-aware. An unchanged
// hunk keeps its threads live, including through rebases and restacks
// that only move positions; a changed or missing hunk leaves them
// outdated for that capture, and they come back if the content does.
package anchor

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// Position states.
const (
	Live     = "live"
	Outdated = "outdated"
)

// Sides, matching store.Side*.
const (
	SideAdditions = "additions"
	SideDeletions = "deletions"
)

// Hunk is one @@ section of a unified git patch. Identity is the hash
// of its body, prefixed content lines with the positional @@ header
// stripped, so a pure position shift (restack, code added above) keeps
// the hash while any content change, whitespace included, produces a
// new one.
type Hunk struct {
	Path     string
	OldStart int
	OldCount int
	NewStart int
	NewCount int
	Hash     string
}

func (h *Hunk) Start(side string) int {
	if side == SideDeletions {
		return h.OldStart
	}
	return h.NewStart
}

func (h *Hunk) count(side string) int {
	if side == SideDeletions {
		return h.OldCount
	}
	return h.NewCount
}

func (h *Hunk) contains(side string, line int) bool {
	start := h.Start(side)
	return line >= start && line < start+h.count(side)
}

// ParsePatch extracts hunks from raw git patch text. Files without
// hunks (binary, pure rename) contribute nothing; threads on them are
// placed by blob identity instead.
func ParsePatch(patch string) []*Hunk {
	var hunks []*Hunk
	var oldPath, newPath string
	var current *Hunk
	var body []string

	flush := func() {
		if current == nil {
			return
		}
		sum := sha256.Sum256([]byte(strings.Join(body, "\n")))
		current.Hash = hex.EncodeToString(sum[:])
		hunks = append(hunks, current)
		current, body = nil, nil
	}

	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			flush()
			oldPath, newPath = "", ""
		case strings.HasPrefix(line, "--- "):
			oldPath = strings.TrimPrefix(strings.TrimPrefix(line, "--- "), "a/")
		case strings.HasPrefix(line, "+++ "):
			newPath = strings.TrimPrefix(strings.TrimPrefix(line, "+++ "), "b/")
		case strings.HasPrefix(line, "@@ "):
			flush()
			h := parseHunkHeader(line)
			if h == nil {
				continue
			}
			h.Path = newPath
			if newPath == "/dev/null" {
				h.Path = oldPath
			}
			current = h
		case current != nil:
			if line == "" {
				// Only the split artifact after the final newline: git writes
				// an empty context line as a lone space.
				continue
			}
			switch line[0] {
			case ' ':
				body = append(body, line)
				current.OldCount++
				current.NewCount++
			case '-':
				body = append(body, line)
				current.OldCount++
			case '+':
				body = append(body, line)
				current.NewCount++
			case '\\':
				body = append(body, line)
			default:
				flush()
			}
		}
	}
	flush()
	return hunks
}

// parseHunkHeader reads "@@ -oldStart[,n] +newStart[,m] @@ ...".
// Counts are recomputed from the body; only the starts are trusted.
func parseHunkHeader(line string) *Hunk {
	rest := strings.TrimPrefix(line, "@@ ")
	end := strings.Index(rest, " @@")
	if end < 0 {
		return nil
	}
	fields := strings.Fields(rest[:end])
	if len(fields) != 2 || !strings.HasPrefix(fields[0], "-") || !strings.HasPrefix(fields[1], "+") {
		return nil
	}
	parseStart := func(s string) int {
		start, _, _ := strings.Cut(s[1:], ",")
		n, _ := strconv.Atoi(start)
		return n
	}
	return &Hunk{OldStart: parseStart(fields[0]), NewStart: parseStart(fields[1])}
}

// Find returns the hunk of path that contains line on side, or nil for
// a line outside every hunk (expanded context).
func Find(hunks []*Hunk, path, side string, line int) *Hunk {
	for _, h := range hunks {
		if h.Path == path && h.contains(side, line) {
			return h
		}
	}
	return nil
}

// Origin is what a thread remembers about where it was written.
type Origin struct {
	Path      string
	Side      string
	StartLine *int
	Line      int
	HunkHash  string // "" when the comment sat outside any hunk
	HunkStart int    // the hunk's start on Side at the time
	SideBlob  string // content hash of Side's file version at the time
}

// Position is where a thread sits in one capture.
type Position struct {
	Path      string `json:"path"`
	Side      string `json:"side"`
	StartLine *int   `json:"startLine,omitempty"`
	Line      int    `json:"line"`
	State     string `json:"state"`
}

// Target is a capture indexed for placement: hunks by path and hash,
// renames from git's detection, and each file side's content hash.
type Target struct {
	byPathHash map[string][]*Hunk
	renames    map[string]string // previous path -> new path
	sideBlob   map[string]string // path\x00side -> content hash
}

func NewTarget(hunks []*Hunk) *Target {
	t := &Target{
		byPathHash: map[string][]*Hunk{},
		renames:    map[string]string{},
		sideBlob:   map[string]string{},
	}
	for _, h := range hunks {
		key := h.Path + "\x00" + h.Hash
		t.byPathHash[key] = append(t.byPathHash[key], h)
	}
	return t
}

// AddFile records a file of the capture: its rename source, if any,
// and the content hashes of both sides ("" when a side does not exist
// or is binary).
func (t *Target) AddFile(path, oldPath, oldHash, newHash string) {
	if oldPath != "" && oldPath != path {
		t.renames[oldPath] = path
	}
	t.sideBlob[path+"\x00"+SideDeletions] = oldHash
	t.sideBlob[path+"\x00"+SideAdditions] = newHash
}

// Locate maps an origin into the target. Candidates never cross paths
// except through git's rename detection: a deleted path leaves its
// threads outdated even if identical content exists elsewhere. Among
// same-path matches the nearest start wins, and the offset inside the
// hunk is kept, so a range shifts as a whole.
func (t *Target) Locate(o Origin) Position {
	keep := Position{Path: o.Path, Side: o.Side, StartLine: o.StartLine, Line: o.Line, State: Outdated}

	mapped := o.Path
	if to, ok := t.renames[o.Path]; ok {
		mapped = to
	}

	if o.HunkHash == "" {
		// Outside any hunk: live exactly while the side is byte-identical.
		if o.SideBlob != "" && t.sideBlob[mapped+"\x00"+o.Side] == o.SideBlob {
			live := keep
			live.Path = mapped
			live.State = Live
			return live
		}
		return keep
	}

	candidates := t.byPathHash[mapped+"\x00"+o.HunkHash]
	if len(candidates) == 0 {
		return keep
	}
	best := candidates[0]
	for _, c := range candidates[1:] {
		if abs(c.Start(o.Side)-o.Line) < abs(best.Start(o.Side)-o.Line) {
			best = c
		}
	}
	delta := best.Start(o.Side) - o.HunkStart
	live := Position{Path: mapped, Side: o.Side, Line: o.Line + delta, State: Live}
	if o.StartLine != nil {
		s := *o.StartLine + delta
		live.StartLine = &s
	}
	return live
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
