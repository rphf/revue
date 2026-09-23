package server

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/rphf/revue/internal/anchor"
	"github.com/rphf/revue/internal/gitx"
	"github.com/rphf/revue/internal/store"
)

// refreshInterval bounds how often one view re-reads the repository: a
// page and its event stream polling together cost one fingerprint per
// interval, not one each.
var refreshInterval = 500 * time.Millisecond

// A view is one diff, named by its git-diff arguments, kept current
// against the repository. Views are created on first use and never
// store anything: the capture is recomputed when the fingerprint moves.
type view struct {
	args []string

	mu          sync.Mutex
	checked     time.Time
	fingerprint string
	cur         *capture // nil until the first refresh
}

// capture is one consistent reading of a view: the diff plus the
// indexes threads are placed with. Handlers take a capture and work
// from it, so a refresh underneath them never mixes two states.
type capture struct {
	version int64
	branch  string
	result  *gitx.Result
	hunks   []*anchor.Hunk
	target  *anchor.Target
	files   map[string]*gitx.File
}

type views struct {
	mu    sync.Mutex
	byKey map[string]*view
}

func newViews() *views {
	return &views{byKey: map[string]*view{}}
}

func viewKey(args []string) string {
	data, _ := json.Marshal(args)
	return string(data)
}

// get returns the view for args, validating them first. nil and empty
// arguments name the same view: the working tree against HEAD.
func (vs *views) get(args []string) (*view, error) {
	if args == nil {
		args = []string{}
	}
	if err := gitx.ValidateArgs(args); err != nil {
		return nil, err
	}
	key := viewKey(args)
	vs.mu.Lock()
	defer vs.mu.Unlock()
	v := vs.byKey[key]
	if v == nil {
		v = &view{args: append([]string{}, args...)}
		vs.byKey[key] = v
	}
	return v, nil
}

// refresh brings the view up to date and reports whether the capture
// changed. Without force it is a no-op within refreshInterval of the
// previous check.
func (v *view) refresh(repoRoot string, force bool) (bool, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !force && v.cur != nil && time.Since(v.checked) < refreshInterval {
		return false, nil
	}
	fp, patch, err := gitx.Fingerprint(repoRoot, v.args)
	if err != nil {
		return false, err
	}
	v.checked = time.Now()
	if v.cur != nil && fp == v.fingerprint {
		return false, nil
	}
	result, err := gitx.Capture(repoRoot, v.args, patch)
	if err != nil {
		return false, err
	}
	c := &capture{
		version: 1,
		branch:  gitx.Branch(repoRoot),
		result:  result,
		hunks:   anchor.ParsePatch(result.Patch),
		files:   map[string]*gitx.File{},
	}
	if v.cur != nil {
		c.version = v.cur.version + 1
	}
	c.target = anchor.NewTarget(c.hunks)
	for i := range result.Files {
		f := &result.Files[i]
		c.files[f.Path] = f
		c.target.AddFile(f.Path, f.OldPath, blobHash(f.OldContent), blobHash(f.NewContent))
	}
	v.fingerprint = fp
	v.cur = c
	return true, nil
}

// current returns the latest capture, nil before the first refresh.
func (v *view) current() *capture {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.cur
}

// load refreshes and returns the capture: the one call handlers make.
func (v *view) load(repoRoot string) (*capture, error) {
	if _, err := v.refresh(repoRoot, false); err != nil {
		return nil, err
	}
	return v.current(), nil
}

func blobHash(content []byte) string {
	if content == nil {
		return ""
	}
	return store.BlobHash(content)
}

type fileView struct {
	Path     string `json:"path"`
	OldPath  string `json:"oldPath,omitempty"`
	Status   string `json:"status"`
	IsBinary bool   `json:"isBinary"`
	OldSize  *int64 `json:"oldSize,omitempty"`
	NewSize  *int64 `json:"newSize,omitempty"`
}

// fileViews lists the files; a binary file also carries the byte size
// of each side it has, since no diff describes it.
func (c *capture) fileViews() []fileView {
	out := make([]fileView, 0, len(c.result.Files))
	for _, f := range c.result.Files {
		v := fileView{Path: f.Path, OldPath: f.OldPath, Status: f.Status, IsBinary: f.IsBinary}
		if f.IsBinary {
			if f.OldOID != "" {
				v.OldSize = &f.OldSize
			}
			if f.Status != gitx.StatusDeleted {
				v.NewSize = &f.NewSize
			}
		}
		out = append(out, v)
	}
	return out
}

// positionView is where one thread sits in this capture.
type positionView struct {
	ThreadID int64 `json:"threadId"`
	anchor.Position
}

func (c *capture) positions(threads []*store.Thread) []positionView {
	out := make([]positionView, 0, len(threads))
	for _, t := range threads {
		out = append(out, positionView{ThreadID: t.ID, Position: c.target.Locate(originOf(t))})
	}
	return out
}

func originOf(t *store.Thread) anchor.Origin {
	blob := t.NewBlob
	if t.Side == store.SideDeletions {
		blob = t.OldBlob
	}
	return anchor.Origin{
		Path: t.Path, Side: t.Side, StartLine: t.StartLine, Line: t.Line,
		HunkHash: t.HunkHash, HunkStart: t.HunkStart, SideBlob: blob,
	}
}
