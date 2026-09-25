package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rphf/revue/internal/gittest"
	"github.com/rphf/revue/internal/store"
)

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func (ts *testServer) listThreadIDs(t *testing.T) []int64 {
	t.Helper()
	var out struct {
		Threads []*threadView `json:"threads"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/threads?drafts=1", nil, &out), http.StatusOK)
	ids := []int64{}
	for _, v := range out.Threads {
		ids = append(ids, v.ID)
	}
	return ids
}

func (ts *testServer) landed(t *testing.T) []int64 {
	t.Helper()
	var out struct {
		ThreadIDs []int64 `json:"threadIds"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/landed", nil, &out), http.StatusOK)
	return out.ThreadIDs
}

// sentThread starts a thread on line 15 and sends it, so it can land.
func (ts *testServer) sentThread(t *testing.T, body string) int64 {
	t.Helper()
	id := ts.draft(t, 15, body)
	ts.send(t, "")
	return id
}

func headOf(t *testing.T, repo string) string {
	t.Helper()
	return strings.TrimSpace(gittest.Git(t, repo, "rev-parse", "HEAD"))
}

func TestThreadRecordsWhereItWasWritten(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.sentThread(t, "why")
	th, err := ts.store.GetThread(id)
	if err != nil {
		t.Fatal(err)
	}
	if th.Branch != "main" || th.Head != headOf(t, ts.repo) || len(th.Args) != 0 {
		t.Fatalf("origin = %q %q %v", th.Branch, th.Head, th.Args)
	}
}

func TestThreadsBelongToTheirBranch(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.sentThread(t, "on main")

	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "other")
	if got := ts.listThreadIDs(t); len(got) != 0 {
		t.Fatalf("threads on another branch = %v", got)
	}
	if anchors := ts.getDiff(t).Anchors; len(anchors) != 0 {
		t.Fatalf("anchors on another branch = %v", anchors)
	}
	if got := ts.landed(t); len(got) != 0 {
		t.Fatalf("a branch switch landed %v", got)
	}
	gittest.Git(t, ts.repo, "checkout", "-q", "main")
	if got := ts.listThreadIDs(t); !slices.Equal(got, []int64{id}) {
		t.Fatalf("threads back on main = %v", got)
	}
}

func TestDetachedHeadScopesByCommit(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	gittest.Git(t, ts.repo, "checkout", "-q", "--detach")
	gittest.Git(t, ts.repo, "commit", "-q", "--allow-empty", "-m", "off main")
	ts.modify(t)
	id := ts.sentThread(t, "detached")
	gittest.Git(t, ts.repo, "commit", "-qam", "c2")
	if got := ts.listThreadIDs(t); !slices.Equal(got, []int64{id}) {
		t.Fatalf("thread after moving HEAD forward = %v", got)
	}
	if got := ts.landed(t); !slices.Equal(got, []int64{id}) {
		t.Fatalf("landed on a detached HEAD = %v", got)
	}
	gittest.Git(t, ts.repo, "checkout", "-q", "main")
	if got := ts.listThreadIDs(t); len(got) != 0 {
		t.Fatalf("thread on a commit HEAD does not contain = %v", got)
	}
}

func TestCommitLandsAWorkingTreeThread(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.sentThread(t, "rename this")
	if got := ts.landed(t); len(got) != 0 {
		t.Fatalf("landed before any commit = %v", got)
	}

	// The agent edits the hunk: outdated, but nothing committed.
	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{15: "line 15 renamed"}))
	if got := ts.landed(t); len(got) != 0 {
		t.Fatalf("landed after an edit without a commit = %v", got)
	}

	gittest.Git(t, ts.repo, "commit", "-qam", "fix")
	if got := ts.landed(t); !slices.Equal(got, []int64{id}) {
		t.Fatalf("landed after the commit = %v", got)
	}

	// A draft on the thread keeps it from landing.
	var reply map[string]any
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/"+itoa(id)+"/comments", map[string]any{"role": "reviewer", "body": "one more"}, &reply), http.StatusCreated)
	if got := ts.landed(t); len(got) != 0 {
		t.Fatalf("landed with a draft = %v", got)
	}
}

func TestMergeLandsARangeThread(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "feat")
	ts.modify(t)
	gittest.Git(t, ts.repo, "commit", "-qam", "feat work")

	var out struct {
		Thread *store.Thread `json:"thread"`
	}
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads", map[string]any{
		"args": []string{"main...HEAD"}, "path": "a.txt", "side": "additions", "line": 15, "body": "range",
	}, &out), http.StatusCreated)
	ts.send(t, "")
	if got := ts.landed(t); len(got) != 0 {
		t.Fatalf("landed before the merge = %v", got)
	}
	gittest.Git(t, ts.repo, "checkout", "-q", "main")
	gittest.Git(t, ts.repo, "merge", "-q", "--ff-only", "feat")
	if got := ts.landed(t); !slices.Equal(got, []int64{out.Thread.ID}) {
		t.Fatalf("landed after the merge = %v", got)
	}
}

func TestDeletedBranchLandsItsThreads(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "throwaway")
	ts.modify(t)
	id := ts.sentThread(t, "gone soon")
	gittest.Git(t, ts.repo, "checkout", "-q", "-f", "main")
	gittest.Git(t, ts.repo, "branch", "-q", "-D", "throwaway")
	if got := ts.landed(t); !slices.Equal(got, []int64{id}) {
		t.Fatalf("landed after deleting the branch = %v", got)
	}
}

func countEvents(t *testing.T, ts *testServer, typ string) int {
	t.Helper()
	events, err := ts.store.EventsSince(0)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range events {
		if e.Type == typ {
			n++
		}
	}
	return n
}

func TestLandingIsOfferedOncePerHead(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.sentThread(t, "offer me")
	gittest.Git(t, ts.repo, "commit", "-qam", "fix")

	var fb struct {
		Landed []int64 `json:"landed"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/feedback", nil, &fb), http.StatusOK)
	if !slices.Equal(fb.Landed, []int64{id}) {
		t.Fatalf("feedback landed = %v", fb.Landed)
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/feedback", nil, &fb), http.StatusOK)
	if n := countEvents(t, ts, eventLanded); n != 1 {
		t.Fatalf("landed offers for one HEAD = %d, want 1", n)
	}
	if got := ts.listThreadIDs(t); !slices.Equal(got, []int64{id}) {
		t.Fatalf("an offer archived the thread: %v", got)
	}
}

func TestAutomaticModeArchivesWhatLanded(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.sentThread(t, "auto")
	gittest.Git(t, ts.repo, "commit", "-qam", "fix")
	fixed := headOf(t, ts.repo)

	var settings settingsView
	ts.mustStatus(t, ts.do(t, "PUT", "/api/settings", settingsView{AutoArchiveLanded: true}, &settings), http.StatusOK)
	ts.mustStatus(t, ts.do(t, "GET", "/api/settings", nil, &settings), http.StatusOK)
	if !settings.AutoArchiveLanded {
		t.Fatal("setting not stored")
	}
	if got := ts.listThreadIDs(t); len(got) != 0 {
		t.Fatalf("threads after turning automatic on = %v", got)
	}
	th, _ := ts.store.GetThread(id)
	if th.ArchivedHead != fixed {
		t.Fatalf("archived at %q, want the fix commit %q", th.ArchivedHead, fixed)
	}
	if n := countEvents(t, ts, eventArchived); n != 1 {
		t.Fatalf("archive events = %d", n)
	}
}

func TestArchiveSelectorsAndUnarchive(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	sent := ts.sentThread(t, "sent")
	draft := ts.draft(t, 15, "draft")

	resp := ts.do(t, "POST", "/api/threads/archive", map[string]any{}, nil)
	ts.mustStatus(t, resp, http.StatusBadRequest)
	resp = ts.do(t, "POST", "/api/threads/archive", map[string]any{"all": true, "landed": true}, nil)
	ts.mustStatus(t, resp, http.StatusBadRequest)
	resp = ts.do(t, "POST", "/api/threads/archive", map[string]any{"ids": []int64{999}}, nil)
	ts.mustStatus(t, resp, http.StatusNotFound)

	// Resolved-and-outdated takes nothing while both threads are live.
	var out struct {
		Archived []int64 `json:"archived"`
		Skipped  []int64 `json:"skipped"`
	}
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/archive", map[string]any{"resolved": true}, &out), http.StatusOK)
	if len(out.Archived) != 0 {
		t.Fatalf("archived live threads: %v", out.Archived)
	}

	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/archive", map[string]any{"all": true}, &out), http.StatusOK)
	if !slices.Equal(out.Archived, []int64{sent}) || !slices.Equal(out.Skipped, []int64{draft}) {
		t.Fatalf("archive all = %+v", out)
	}
	if got := ts.listThreadIDs(t); !slices.Equal(got, []int64{draft}) {
		t.Fatalf("visible after archive = %v", got)
	}

	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/"+itoa(sent)+"/unarchive", nil, nil), http.StatusOK)
	if got := ts.listThreadIDs(t); !slices.Equal(got, []int64{sent, draft}) {
		t.Fatalf("visible after unarchive = %v", got)
	}
	// Brought back by hand, it does not land again.
	gittest.Git(t, ts.repo, "commit", "-qam", "fix")
	if got := ts.landed(t); slices.Contains(got, sent) {
		t.Fatalf("an unarchived thread landed again: %v", got)
	}
}

func TestResolvedSelectorTakesResolvedAndOutdatedThreads(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{2: "line 2 CHANGED", 15: changedLine}))
	top := ts.draft(t, 2, "top")
	bottom := ts.draft(t, 15, "bottom")
	ts.send(t, "")
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/"+itoa(top)+"/resolve", nil, nil), http.StatusOK)
	// Rewriting line 15 outdates the bottom thread.
	writeFile(t, ts.repo, "a.txt", fixtureContent(map[int]string{2: "line 2 CHANGED", 15: "line 15 again"}))
	keep := ts.draft(t, 15, "live one")
	ts.send(t, "")

	var out struct {
		Archived []int64 `json:"archived"`
	}
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/archive", map[string]any{"resolved": true}, &out), http.StatusOK)
	if !slices.Equal(out.Archived, []int64{top, bottom}) {
		t.Fatalf("archived = %v, want %v", out.Archived, []int64{top, bottom})
	}
	if got := ts.listThreadIDs(t); !slices.Equal(got, []int64{keep}) {
		t.Fatalf("left = %v", got)
	}
}

type historyResponse struct {
	Branch   string          `json:"branch"`
	Current  string          `json:"current"`
	Branches []historyBranch `json:"branches"`
	Commits  []struct {
		Hash     string        `json:"hash"`
		Subject  string        `json:"subject"`
		OnBranch bool          `json:"onBranch"`
		Missing  bool          `json:"missing"`
		Threads  []*threadView `json:"threads"`
	} `json:"commits"`
	More bool `json:"more"`
}

func TestHistoryListsTheBranchWithThreadsUnderTheirCommit(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "feat")
	writeFile(t, ts.repo, "b.txt", "b\n")
	gittest.Git(t, ts.repo, "add", "-A")
	gittest.Git(t, ts.repo, "commit", "-qm", "quiet commit")
	ts.modify(t)
	id := ts.sentThread(t, "fix me")
	gittest.Git(t, ts.repo, "commit", "-qam", "the fix")
	fix := headOf(t, ts.repo)
	var out struct {
		Archived []int64 `json:"archived"`
	}
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/archive", map[string]any{"landed": true}, &out), http.StatusOK)
	if !slices.Equal(out.Archived, []int64{id}) {
		t.Fatalf("archived = %v", out.Archived)
	}

	var h historyResponse
	ts.mustStatus(t, ts.do(t, "GET", "/api/history", nil, &h), http.StatusOK)
	if h.Branch != "feat" || h.Current != "feat" || len(h.Commits) != 2 {
		t.Fatalf("history = %+v", h)
	}
	if h.Commits[0].Hash != fix || h.Commits[0].Subject != "the fix" || len(h.Commits[0].Threads) != 1 || h.Commits[0].Threads[0].ID != id {
		t.Fatalf("newest commit = %+v", h.Commits[0])
	}
	if h.Commits[1].Subject != "quiet commit" || len(h.Commits[1].Threads) != 0 || !h.Commits[1].OnBranch {
		t.Fatalf("commit without threads = %+v", h.Commits[1])
	}
	if len(h.Commits[0].Threads[0].Comments) != 1 {
		t.Fatalf("history thread comments = %v", h.Commits[0].Threads[0].Comments)
	}
	if len(h.Branches) != 1 || h.Branches[0].Name != "feat" || h.Branches[0].Threads != 1 {
		t.Fatalf("branches = %+v", h.Branches)
	}

	// A rebase rewrites the fix: its thread stays, marked off the branch.
	gittest.Git(t, ts.repo, "commit", "-q", "--amend", "-m", "the fix, reworded")
	ts.mustStatus(t, ts.do(t, "GET", "/api/history", nil, &h), http.StatusOK)
	var rewritten bool
	for _, c := range h.Commits {
		if c.Hash == fix {
			rewritten = !c.OnBranch && len(c.Threads) == 1
		}
	}
	if !rewritten {
		t.Fatalf("rewritten commit not marked: %+v", h.Commits)
	}

	// Another branch's history is reachable by name.
	gittest.Git(t, ts.repo, "checkout", "-q", "-f", "main")
	ts.mustStatus(t, ts.do(t, "GET", "/api/history?branch=feat", nil, &h), http.StatusOK)
	if h.Branch != "feat" || h.Current != "main" || len(h.Commits) == 0 {
		t.Fatalf("history of feat from main = %+v", h)
	}
}

func TestHistoryCapsTheLog(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "long")
	for i := range 3 {
		gittest.Git(t, ts.repo, "commit", "-q", "--allow-empty", "-m", "c"+itoa(int64(i)))
	}
	var h historyResponse
	ts.mustStatus(t, ts.do(t, "GET", "/api/history?limit=2", nil, &h), http.StatusOK)
	if len(h.Commits) != 2 || !h.More {
		t.Fatalf("capped history = %d commits, more %v", len(h.Commits), h.More)
	}
}

func TestParseRetention(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"90d": 90 * 24 * time.Hour, "0": 0, "2160h": 2160 * time.Hour, "0d": 0,
	} {
		if got, err := ParseRetention(in); err != nil || got != want {
			t.Errorf("ParseRetention(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"soon", "-1h", "xd", "-3d"} {
		if _, err := ParseRetention(bad); err == nil {
			t.Errorf("ParseRetention(%q) accepted", bad)
		}
	}
}

func TestServerRecordsItsRepository(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	v, ok, err := ts.store.Setting(settingRepo)
	if err != nil || !ok || !strings.Contains(v, ts.repo) {
		t.Fatalf("repo setting = %q %v %v", v, ok, err)
	}
}

// Threads from before origins were recorded belong to no branch: no
// list, branch view or History shows them, archived or not.
func TestThreadsWithoutOriginShowNowhere(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	id := ts.sentThread(t, "old thread")
	db, err := sql.Open("sqlite", "file:"+filepath.Join(ts.dataDir, "revue.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("UPDATE threads SET branch = '', head = '', base = '' WHERE id = ?", id); err != nil {
		t.Fatal(err)
	}

	var list struct {
		Threads []*threadView `json:"threads"`
	}
	for _, path := range []string{"/api/threads", "/api/threads?branch=main", "/api/threads?branch="} {
		ts.mustStatus(t, ts.do(t, "GET", path, nil, &list), http.StatusOK)
		if len(list.Threads) != 0 {
			t.Fatalf("%s = %+v", path, list.Threads)
		}
	}

	var out struct {
		Archived []int64 `json:"archived"`
	}
	ts.mustStatus(t, ts.do(t, "POST", "/api/threads/archive", map[string]any{"ids": []int64{id}}, &out), http.StatusOK)
	if len(out.Archived) != 1 {
		t.Fatalf("archived = %v", out.Archived)
	}
	var h historyResponse
	ts.mustStatus(t, ts.do(t, "GET", "/api/history", nil, &h), http.StatusOK)
	for _, c := range h.Commits {
		if len(c.Threads) != 0 {
			t.Fatalf("history on main = %+v", h)
		}
	}
	for _, b := range h.Branches {
		if b.Name == "" {
			t.Fatalf("threads without origin listed as a branch: %+v", h.Branches)
		}
	}
}

func TestAnotherBranchsThreadsAndTheBranchList(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	gittest.Git(t, ts.repo, "checkout", "-q", "-b", "feat")
	ts.modify(t)
	onFeat := ts.sentThread(t, "on feat")
	gittest.Git(t, ts.repo, "checkout", "-q", "-f", "main")

	var list struct {
		Threads []*threadView `json:"threads"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/threads?branch=feat", nil, &list), http.StatusOK)
	if len(list.Threads) != 1 || list.Threads[0].ID != onFeat {
		t.Fatalf("threads of feat = %+v", list.Threads)
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/threads", nil, &list), http.StatusOK)
	if len(list.Threads) != 0 {
		t.Fatalf("threads of main = %+v", list.Threads)
	}

	var branches struct {
		Current  string       `json:"current"`
		Branches []branchView `json:"branches"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/branches", nil, &branches), http.StatusOK)
	want := []branchView{{Name: "main"}, {Name: "feat", Open: 1}}
	if branches.Current != "main" || !slices.Equal(branches.Branches, want) {
		t.Fatalf("branches = %+v", branches)
	}
}

func TestArchivedThreadsListNewestFirst(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	ts.modify(t)
	first := ts.sentThread(t, "first")
	second := ts.sentThread(t, "second")
	for _, id := range []int64{first, second} {
		ts.mustStatus(t, ts.do(t, "POST", "/api/threads/archive", map[string]any{"ids": []int64{id}}, nil), http.StatusOK)
		time.Sleep(5 * time.Millisecond)
	}
	var out struct {
		Threads []*threadView `json:"threads"`
	}
	ts.mustStatus(t, ts.do(t, "GET", "/api/threads?archived=1", nil, &out), http.StatusOK)
	if len(out.Threads) != 2 || out.Threads[0].ID != second || out.Threads[1].ID != first || out.Threads[0].ArchivedAt == nil {
		t.Fatalf("archived list = %+v", out.Threads)
	}
}

// A change another request read first still reaches every open page:
// the stream compares versions, not whether its own refresh saw it.
func TestSSENotifiesAChangeAnotherRequestRefreshedFirst(t *testing.T) {
	ts := startServer(t, initRepo(t), 0)
	req, _ := http.NewRequest("GET", ts.URL()+"/api/events?since=0", nil)
	req.Header.Set("Authorization", "Bearer "+ts.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	frames := readFrames(t, resp.Body)
	if first := nextFrame(t, frames, 3*time.Second); first.Type != eventDiffChanged {
		t.Fatalf("first frame = %+v", first)
	}

	ts.modify(t)
	want := ts.getDiff(t).Version // this request refreshes the view first
	for {
		f := nextFrame(t, frames, 4*time.Second)
		if f.Type != eventDiffChanged {
			continue
		}
		var notice struct {
			Version int64 `json:"version"`
		}
		_ = json.Unmarshal(f.Payload, &notice)
		if notice.Version == want {
			return
		}
	}
}
