// Package anchor implements the cross-round carry-over engine (KTD3):
// when a new round is created, every thread's and draft's anchor is
// mapped from the previous round into the new one by normalized hunk
// content, rename-aware. Unchanged hunks keep their threads live —
// including through rebases and restacks that only move positions —
// and changed hunks mark them outdated with history preserved.
package anchor

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/rphf/revue/internal/store"
)

type Engine struct{}

func New() *Engine { return &Engine{} }

// hunk is one @@ section of a unified git patch. Identity is the hash
// of its body — prefixed content lines with the positional @@ header
// stripped — so a pure position shift (restack, code added above)
// keeps the hash while any content change, whitespace included,
// produces a new one.
type hunk struct {
	path     string
	oldStart int
	oldCount int
	newStart int
	newCount int
	hash     string
}

func (h *hunk) start(side string) int {
	if side == store.SideDeletions {
		return h.oldStart
	}
	return h.newStart
}

func (h *hunk) count(side string) int {
	if side == store.SideDeletions {
		return h.oldCount
	}
	return h.newCount
}

func (h *hunk) contains(side string, line int) bool {
	start := h.start(side)
	return line >= start && line < start+h.count(side)
}

// parsePatch extracts hunks from raw git patch text. Files without
// hunks (binary, pure rename) contribute nothing; their threads are
// handled by blob identity instead.
func parsePatch(patch string) []*hunk {
	var hunks []*hunk
	var oldPath, newPath string
	var current *hunk
	var body []string

	flush := func() {
		if current == nil {
			return
		}
		sum := sha256.Sum256([]byte(strings.Join(body, "\n")))
		current.hash = hex.EncodeToString(sum[:])
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
			h.path = newPath
			if newPath == "/dev/null" {
				h.path = oldPath
			}
			current = h
		case current != nil:
			if line == "" || line[0] == ' ' || line[0] == '+' || line[0] == '-' || line[0] == '\\' {
				body = append(body, line)
				if line == "" || line[0] == ' ' {
					current.oldCount++
					current.newCount++
				} else if line[0] == '-' {
					current.oldCount++
				} else if line[0] == '+' {
					current.newCount++
				}
			} else {
				flush()
			}
		}
	}
	flush()
	return hunks
}

// parseHunkHeader reads "@@ -oldStart[,n] +newStart[,m] @@ ...".
// Counts are recomputed from the body; only the starts are trusted.
func parseHunkHeader(line string) *hunk {
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
		s = s[1:]
		if i := strings.Index(s, ","); i >= 0 {
			s = s[:i]
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			return 0
		}
		return n
	}
	return &hunk{oldStart: parseStart(fields[0]), newStart: parseStart(fields[1])}
}

func sideBlob(f *store.RoundFile, side string) string {
	if f == nil {
		return ""
	}
	if side == store.SideDeletions {
		return f.OldBlob
	}
	return f.NewBlob
}

// Recompute maps every previous-round anchor into the new round.
// Threads and drafts follow identical rules (R21); a thread that goes
// outdated keeps its last position so it stays reachable (R22), and
// an already-outdated thread never resurrects (GitHub parity), even
// if its original content reappears.
func (e *Engine) Recompute(tx *store.Store, reviewID, prevRoundID, newRoundID int64) error {
	prevAnchors, err := tx.AnchorsForRound(prevRoundID)
	if err != nil {
		return err
	}
	if len(prevAnchors) == 0 {
		return nil
	}
	prevRound, err := tx.RoundByID(prevRoundID)
	if err != nil {
		return err
	}
	newRound, err := tx.RoundByID(newRoundID)
	if err != nil {
		return err
	}
	prevFilesList, err := tx.FilesForRound(prevRoundID)
	if err != nil {
		return err
	}
	newFilesList, err := tx.FilesForRound(newRoundID)
	if err != nil {
		return err
	}

	prevFiles := map[string]*store.RoundFile{}
	for _, f := range prevFilesList {
		prevFiles[f.Path] = f
	}
	newFiles := map[string]*store.RoundFile{}
	rename := map[string]string{} // previous path -> new path (git -M)
	for _, f := range newFilesList {
		newFiles[f.Path] = f
		if f.Status == store.FileRenamed && f.OldPath != "" {
			rename[f.OldPath] = f.Path
		}
	}

	prevHunks := parsePatch(prevRound.Patch)
	// New-round hunks indexed by (path, hash): candidates never cross
	// paths except through git's rename detection — a deleted path
	// goes outdated even if identical content exists elsewhere.
	newByPathHash := map[string][]*hunk{}
	for _, h := range parsePatch(newRound.Patch) {
		key := h.path + "\x00" + h.hash
		newByPathHash[key] = append(newByPathHash[key], h)
	}

	for _, a := range prevAnchors {
		state, anchor, hunkHash := carry(a, prevHunks, newByPathHash, rename, prevFiles, newFiles)
		if err := tx.UpsertAnchor(a.ThreadID, newRoundID, anchor, state, hunkHash); err != nil {
			return err
		}
	}
	return nil
}

func carry(
	a *store.ThreadAnchor,
	prevHunks []*hunk,
	newByPathHash map[string][]*hunk,
	rename map[string]string,
	prevFiles, newFiles map[string]*store.RoundFile,
) (state string, anchor store.Anchor, hunkHash string) {
	keep := a.Anchor // last known position: outdated threads stay reachable there

	// Once outdated, always outdated.
	if a.State == store.AnchorOutdated {
		return store.AnchorOutdated, keep, a.HunkHash
	}

	mapped := a.Path
	if to, ok := rename[a.Path]; ok {
		mapped = to
	}

	// Find the hunk the thread sits in within the previous round.
	var prev *hunk
	for _, h := range prevHunks {
		if h.path == a.Path && h.contains(a.Side, a.Line) {
			prev = h
			break
		}
	}

	if prev == nil {
		// Outside any hunk (e.g. a comment on expanded context, R25):
		// live exactly while the side's blob is byte-identical.
		pb := sideBlob(prevFiles[a.Path], a.Side)
		nb := sideBlob(newFiles[mapped], a.Side)
		if pb != "" && pb == nb {
			live := keep
			live.Path = mapped
			return store.AnchorLive, live, ""
		}
		return store.AnchorOutdated, keep, ""
	}

	candidates := newByPathHash[mapped+"\x00"+prev.hash]
	if len(candidates) == 0 {
		return store.AnchorOutdated, keep, prev.hash
	}

	// Tie-break: nearest start position within the (rename-mapped) path.
	best := candidates[0]
	for _, c := range candidates[1:] {
		if abs(c.start(a.Side)-a.Line) < abs(best.start(a.Side)-a.Line) {
			best = c
		}
	}

	offset := a.Line - prev.start(a.Side)
	newLine := best.start(a.Side) + offset
	delta := newLine - a.Line
	live := store.Anchor{Path: mapped, Side: a.Side, Line: newLine}
	if a.StartLine != nil {
		s := *a.StartLine + delta
		live.StartLine = &s
	}
	return store.AnchorLive, live, prev.hash
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
