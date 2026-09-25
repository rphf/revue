package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rphf/revue/internal/anchor"
	"github.com/rphf/revue/internal/gitx"
	"github.com/rphf/revue/internal/store"
)

// Archive events. threads.landed offers the landed threads to the
// reviewer; it is logged once per HEAD.
const (
	eventArchived   = "thread.archived"
	eventUnarchived = "thread.unarchived"
	eventLanded     = "threads.landed"
	eventSettings   = "settings.changed"
)

const (
	settingAutoArchive = "autoArchiveLanded"
	settingRepo        = "repo"
)

// repoState caches what the repository's HEAD is, and ancestry answers,
// which never change for a pair of commits.
type repoState struct {
	mu       sync.Mutex
	checked  time.Time
	commit   string
	branch   string
	ancestry map[[2]string]bool
	bases    map[[2]string]string
	// The default branch and its tip, re-read with HEAD.
	defChecked time.Time
	defRef     string
	defName    string
	defTip     string
	// checkedHead is the HEAD the landing check last ran for; offered is
	// the HEAD whose landed threads were last offered.
	checkedHead string
	offered     string
}

// defaultBranch returns the default branch's ref, name and tip, re-read
// at most once per refreshInterval. The tip is "" without one.
func (s *Server) defaultBranch() (ref, name, tip string) {
	r := &s.repo
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.defChecked.IsZero() || time.Since(r.defChecked) >= refreshInterval {
		r.defRef, r.defName = gitx.DefaultBranch(s.repoRoot)
		r.defTip, _ = gitx.ResolveRef(s.repoRoot, r.defRef)
		r.defChecked = time.Now()
	}
	return r.defRef, r.defName, r.defTip
}

// head returns HEAD's commit and branch ("" when detached), re-read at
// most once per refreshInterval.
func (s *Server) head() (commit, branch string) {
	r := &s.repo
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.checked.IsZero() || time.Since(r.checked) >= refreshInterval {
		r.commit, r.branch = gitx.Head(s.repoRoot)
		r.checked = time.Now()
	}
	return r.commit, r.branch
}

func (s *Server) isAncestor(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	key := [2]string{a, b}
	r := &s.repo
	r.mu.Lock()
	v, ok := r.ancestry[key]
	r.mu.Unlock()
	if ok {
		return v
	}
	v = gitx.IsAncestor(s.repoRoot, a, b)
	r.mu.Lock()
	if r.ancestry == nil {
		r.ancestry = map[[2]string]bool{}
	}
	r.ancestry[key] = v
	r.mu.Unlock()
	return v
}

// inScope reports whether a thread belongs to the checkout at commit on
// branch: its own branch, or on a detached HEAD, a commit HEAD contains.
// A thread from before origins were recorded belongs nowhere: no branch
// can claim it.
func (s *Server) inScope(t *store.Thread, commit, branch string) bool {
	if !t.HasOrigin() {
		return false
	}
	if t.Branch != "" && branch != "" {
		return t.Branch == branch
	}
	return t.Head == commit || s.isAncestor(t.Head, commit)
}

// scopedThreads lists the unarchived threads of the current checkout.
func (s *Server) scopedThreads(includeDrafts bool) ([]*store.Thread, error) {
	threads, err := s.store.ListThreads(includeDrafts)
	if err != nil {
		return nil, err
	}
	commit, branch := s.head()
	return slices.DeleteFunc(threads, func(t *store.Thread) bool { return !s.inScope(t, commit, branch) }), nil
}

// threadViews lists the current checkout's threads with their comments.
func (s *Server) threadViews(includeDrafts, withQuotes, unresolvedOnly bool) ([]*threadView, error) {
	threads, err := s.scopedThreads(includeDrafts)
	if err != nil {
		return nil, err
	}
	if unresolvedOnly {
		threads = slices.DeleteFunc(threads, func(t *store.Thread) bool { return t.Resolved })
	}
	return viewsOf(s.store, threads, includeDrafts, withQuotes)
}

// branchThreadViews lists the unarchived threads written on a branch.
func (s *Server) branchThreadViews(branch string, includeDrafts, withQuotes bool) ([]*threadView, error) {
	threads, err := s.store.ListThreads(includeDrafts)
	if err != nil {
		return nil, err
	}
	threads = slices.DeleteFunc(threads, func(t *store.Thread) bool {
		return !t.HasOrigin() || t.Branch != branch
	})
	return viewsOf(s.store, threads, includeDrafts, withQuotes)
}

type branchView struct {
	Name     string `json:"name"`
	Open     int    `json:"open"`
	Archived int    `json:"archived"`
}

// handleBranches lists the branches that have threads, open or archived,
// the checked-out one first and always present.
func (s *Server) handleBranches(w http.ResponseWriter, _ *http.Request) {
	_, current := s.head()
	open, err := s.store.ListThreads(false)
	if err != nil {
		internalError(w, err)
		return
	}
	archived, err := s.store.ListArchivedThreads()
	if err != nil {
		internalError(w, err)
		return
	}
	byName := map[string]*branchView{current: {Name: current}}
	add := func(t *store.Thread, isOpen bool) {
		if !t.HasOrigin() {
			return
		}
		b := byName[t.Branch]
		if b == nil {
			b = &branchView{Name: t.Branch}
			byName[t.Branch] = b
		}
		if isOpen {
			b.Open++
		} else {
			b.Archived++
		}
	}
	for _, t := range open {
		add(t, true)
	}
	for _, t := range archived {
		add(t, false)
	}
	out := make([]branchView, 0, len(byName))
	for _, b := range byName {
		out = append(out, *b)
	}
	slices.SortFunc(out, func(a, b branchView) int {
		switch {
		case a.Name == current:
			return -1
		case b.Name == current:
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"current": current, "branches": out})
}

// liveIn reports whether a thread maps into the current diff of the
// arguments it was written on. captures caches one capture per diff.
func (s *Server) liveIn(t *store.Thread, captures map[string]*capture) (bool, error) {
	key := viewKey(t.Args)
	c, ok := captures[key]
	if !ok {
		v, err := s.views.get(t.Args)
		if err != nil {
			return false, err
		}
		if c, err = v.load(s.repoRoot); err != nil {
			return false, err
		}
		captures[key] = c
	}
	return c.target.Locate(originOf(t)).State == anchor.Live, nil
}

// landedThreads lists the unarchived threads whose code has landed, and
// the HEAD they landed at. A thread holding a draft, or brought back by
// hand, never lands. Two rules:
//   - a thread written on the working tree, on the branch checked out,
//     lands once HEAD moved past the commit it was written on and it no
//     longer maps into its diff: its code was committed;
//   - a thread written on a branch lands once that branch is merged into
//     the default branch, or deleted.
func (s *Server) landedThreads() (string, []int64, error) {
	commit, branch := s.head()
	landed := []int64{}
	if commit == "" {
		return commit, landed, nil
	}
	threads, err := s.store.ListThreads(false)
	if err != nil {
		return "", nil, err
	}
	drafts, err := s.store.ThreadsWithDrafts()
	if err != nil {
		return "", nil, err
	}
	merged := s.mergedBranches()
	captures := map[string]*capture{}
	for _, t := range threads {
		if !t.HasOrigin() || t.Kept || drafts[t.ID] {
			continue
		}
		if merged(t.Branch, t.Base) {
			landed = append(landed, t.ID)
			continue
		}
		if !gitx.IsWorkingTree(t.Args) || t.Head == commit || !s.inScope(t, commit, branch) {
			continue
		}
		live, err := s.liveIn(t, captures)
		if err != nil {
			return "", nil, err
		}
		if !live {
			landed = append(landed, t.ID)
		}
	}
	return commit, landed, nil
}

// mergedBranches returns a check for "this thread's branch has been
// merged into the default branch or deleted", reading each branch tip
// once. base is where the branch left the default branch when the
// thread was written.
func (s *Server) mergedBranches() func(branch, base string) bool {
	_, defName, defTip := s.defaultBranch()
	hasDefault := defTip != ""
	tips := map[string]*string{}
	return func(branch, base string) bool {
		if branch == "" || !hasDefault || branch == defName {
			return false
		}
		tip, seen := tips[branch]
		if !seen {
			if t, ok := gitx.BranchTip(s.repoRoot, branch); ok {
				tip = &t
			}
			tips[branch] = tip
		}
		if tip == nil {
			return true // deleted
		}
		// A tip still at the base has no work of its own: it is in the
		// default branch without anything having been merged.
		return *tip != base && s.isAncestor(*tip, defTip)
	}
}

// baseOf is where HEAD left the default branch, "" without one. Merge
// bases of two commits never change, so each pair is asked once.
func (s *Server) baseOf(head string) string {
	_, _, tip := s.defaultBranch()
	if tip == "" || head == "" {
		return ""
	}
	key := [2]string{head, tip}
	r := &s.repo
	r.mu.Lock()
	base, ok := r.bases[key]
	r.mu.Unlock()
	if ok {
		return base
	}
	base = gitx.MergeBase(s.repoRoot, head, tip)
	r.mu.Lock()
	if r.bases == nil {
		r.bases = map[[2]string]string{}
	}
	r.bases[key] = base
	r.mu.Unlock()
	return base
}

// checkLanding runs the landing check once per HEAD: with the automatic
// setting on it archives what landed, otherwise it offers it once.
func (s *Server) checkLanding() {
	commit, _ := s.head()
	r := &s.repo
	r.mu.Lock()
	if commit == r.checkedHead {
		r.mu.Unlock()
		return
	}
	r.checkedHead = commit
	r.mu.Unlock()
	_ = s.handleLanding()
}

func (s *Server) handleLanding() error {
	commit, ids, err := s.landedThreads()
	if err != nil || len(ids) == 0 {
		return err
	}
	if s.autoArchive() {
		_, err := s.archive(ids, commit)
		return err
	}
	r := &s.repo
	r.mu.Lock()
	if r.offered == commit {
		r.mu.Unlock()
		return nil
	}
	r.offered = commit
	r.mu.Unlock()
	if _, err := s.store.AppendEvent(eventLanded, map[string]any{"head": commit, "threadIds": ids}); err != nil {
		return err
	}
	s.bus.notify()
	return nil
}

func (s *Server) autoArchive() bool {
	v, ok, err := s.store.Setting(settingAutoArchive)
	return err == nil && ok && v == "true"
}

// archive archives the threads at head, logs one event, and returns the
// ids it archived.
func (s *Server) archive(ids []int64, head string) ([]int64, error) {
	var archived []int64
	err := s.store.WithTx(func(tx *store.Store) error {
		var err error
		if archived, err = tx.ArchiveThreads(ids, head); err != nil || len(archived) == 0 {
			return err
		}
		_, err = tx.AppendEvent(eventArchived, map[string]any{"threadIds": archived, "head": head})
		return err
	})
	if err != nil {
		return nil, err
	}
	if len(archived) > 0 {
		s.bus.notify()
	}
	return archived, nil
}

// --- handlers ---

type archiveRequest struct {
	IDs      []int64 `json:"ids"`
	Landed   bool    `json:"landed"`
	Resolved bool    `json:"resolved"`
	All      bool    `json:"all"`
}

// handleArchive archives the threads named by one selector: ids, the
// landed ones, the resolved and outdated ones, or every thread of the
// current checkout. Threads holding a draft are skipped and reported.
func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	var req archiveRequest
	if !readJSON(w, r, &req) {
		return
	}
	selectors := 0
	for _, on := range []bool{len(req.IDs) > 0, req.Landed, req.Resolved, req.All} {
		if on {
			selectors++
		}
	}
	if selectors != 1 {
		httpError(w, http.StatusBadRequest, "validation", "pass exactly one of ids, landed, resolved, all")
		return
	}
	commit, _ := s.head()
	var ids []int64
	switch {
	case len(req.IDs) > 0:
		for _, id := range req.IDs {
			if _, err := s.store.GetThread(id); errors.Is(err, store.ErrNotFound) {
				httpError(w, http.StatusNotFound, "not_found", fmt.Sprintf("thread %d not found", id))
				return
			} else if err != nil {
				internalError(w, err)
				return
			}
		}
		ids = req.IDs
	case req.Landed:
		var err error
		if commit, ids, err = s.landedThreads(); err != nil {
			internalError(w, err)
			return
		}
	default:
		threads, err := s.scopedThreads(true)
		if err != nil {
			internalError(w, err)
			return
		}
		captures := map[string]*capture{}
		for _, t := range threads {
			if req.Resolved && !t.Resolved {
				live, err := s.liveIn(t, captures)
				if err != nil {
					internalError(w, err)
					return
				}
				if live {
					continue
				}
			}
			ids = append(ids, t.ID)
		}
	}
	archived, err := s.archive(ids, commit)
	if err != nil {
		internalError(w, err)
		return
	}
	skipped := []int64{}
	for _, id := range ids {
		if !slices.Contains(archived, id) {
			skipped = append(skipped, id)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"archived": archived, "skipped": skipped, "head": commit})
}

func (s *Server) handleUnarchive(w http.ResponseWriter, r *http.Request) {
	thread, ok := s.threadFromPath(w, r)
	if !ok {
		return
	}
	err := s.store.WithTx(func(tx *store.Store) error {
		if err := tx.UnarchiveThread(thread.ID); err != nil {
			return err
		}
		_, err := tx.AppendEvent(eventUnarchived, map[string]any{"threadIds": []int64{thread.ID}})
		return err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	s.bus.notify()
	writeJSON(w, http.StatusOK, map[string]any{"threadId": thread.ID})
}

func (s *Server) handleLanded(w http.ResponseWriter, _ *http.Request) {
	commit, ids, err := s.landedThreads()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"head": commit, "threadIds": ids})
}

type settingsView struct {
	AutoArchiveLanded bool `json:"autoArchiveLanded"`
}

func (s *Server) handleGetSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, settingsView{AutoArchiveLanded: s.autoArchive()})
}

// handlePutSettings stores the settings. Turning automatic archiving on
// archives what has already landed.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var req settingsView
	if !readJSON(w, r, &req) {
		return
	}
	err := s.store.WithTx(func(tx *store.Store) error {
		if err := tx.SetSetting(settingAutoArchive, strconv.FormatBool(req.AutoArchiveLanded)); err != nil {
			return err
		}
		_, err := tx.AppendEvent(eventSettings, req)
		return err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	s.bus.notify()
	if req.AutoArchiveLanded {
		if err := s.handleLanding(); err != nil {
			internalError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, req)
}

// --- history ---

const historyLimit = 200

type historyCommit struct {
	gitx.Commit
	// OnBranch is false for a commit the branch no longer contains, such
	// as one a rebase rewrote; Missing for one the repository lost.
	OnBranch bool          `json:"onBranch"`
	Missing  bool          `json:"missing,omitempty"`
	Threads  []*threadView `json:"threads"`
}

type historyBranch struct {
	Name    string `json:"name"`
	Threads int    `json:"threads"`
}

// handleHistory lists a branch's archived threads under the commit each
// landed in. For a branch that still has commits of its own, those
// commits come too, threads or not, so the list reads like its log.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	_, current := s.head()
	branch := current
	if r.URL.Query().Has("branch") {
		branch = r.URL.Query().Get("branch")
	}
	limit := historyLimit
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
		limit = n
	}

	archived, err := s.store.ListArchivedThreads()
	if err != nil {
		internalError(w, err)
		return
	}
	// A thread from before origins were recorded is in no branch's
	// History, as in no branch's lists.
	counts := map[string]int{}
	var mine []*store.Thread
	for _, t := range archived {
		if !t.HasOrigin() {
			continue
		}
		counts[t.Branch]++
		if t.Branch == branch {
			mine = append(mine, t)
		}
	}
	branches := []historyBranch{}
	for name, n := range counts {
		branches = append(branches, historyBranch{Name: name, Threads: n})
	}
	slices.SortFunc(branches, func(a, b historyBranch) int {
		switch {
		case a.Name == current:
			return -1
		case b.Name == current:
			return 1
		case a.Name < b.Name:
			return -1
		case a.Name > b.Name:
			return 1
		}
		return 0
	})

	views, err := viewsOf(s.store, mine, false, false)
	if err != nil {
		internalError(w, err)
		return
	}
	byHead := map[string][]*threadView{}
	var heads []string
	for _, v := range views {
		if _, ok := byHead[v.ArchivedHead]; !ok {
			heads = append(heads, v.ArchivedHead)
		}
		byHead[v.ArchivedHead] = append(byHead[v.ArchivedHead], v)
	}

	var commits []historyCommit
	more := false
	tip, onBranch := gitx.BranchTip(s.repoRoot, branch)
	defRef, defName, _ := s.defaultBranch()
	seen := map[string]bool{}
	if onBranch && branch != defName && defRef != "" {
		log, err := gitx.Log(s.repoRoot, defRef+".."+branch, limit+1)
		if err != nil {
			internalError(w, err)
			return
		}
		if len(log) > limit {
			log, more = log[:limit], true
		}
		for _, c := range log {
			seen[c.Hash] = true
			commits = append(commits, historyCommit{Commit: c, OnBranch: true, Threads: orEmpty(byHead[c.Hash])})
		}
	}
	var rest []string
	for _, h := range heads {
		if !seen[h] {
			rest = append(rest, h)
		}
	}
	known, err := gitx.Commits(s.repoRoot, rest)
	if err != nil {
		internalError(w, err)
		return
	}
	found := map[string]bool{}
	var extra []historyCommit
	for _, c := range known {
		found[c.Hash] = true
		extra = append(extra, historyCommit{Commit: c, OnBranch: onBranch && s.isAncestor(c.Hash, tip), Threads: byHead[c.Hash]})
	}
	slices.SortStableFunc(extra, func(a, b historyCommit) int { return b.Date.Compare(a.Date) })
	commits = mergeByDate(commits, extra)
	for _, h := range rest {
		if !found[h] {
			commits = append(commits, historyCommit{Commit: gitx.Commit{Hash: h}, Missing: true, Threads: byHead[h]})
		}
	}
	if commits == nil {
		commits = []historyCommit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"branch": branch, "current": current, "branches": branches, "commits": commits, "more": more,
	})
}

func orEmpty(v []*threadView) []*threadView {
	if v == nil {
		return []*threadView{}
	}
	return v
}

// mergeByDate merges two lists already sorted newest first.
func mergeByDate(a, b []historyCommit) []historyCommit {
	out := make([]historyCommit, 0, len(a)+len(b))
	for len(a) > 0 && len(b) > 0 {
		if b[0].Date.After(a[0].Date) {
			out, b = append(out, b[0]), b[1:]
		} else {
			out, a = append(out, a[0]), a[1:]
		}
	}
	return append(append(out, a...), b...)
}

// recordRepo stores the repository path in the database, so a cleanup
// of the data directories can tell whether it still exists.
func (s *Server) recordRepo() error {
	data, err := json.Marshal(s.repoRoot)
	if err != nil {
		return err
	}
	return s.store.SetSetting(settingRepo, string(data))
}
