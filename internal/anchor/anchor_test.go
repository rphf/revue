package anchor

import (
	"path/filepath"
	"testing"

	"github.com/rphf/revue/internal/store"
)

// The carry-over engine is built test-first: this table encodes AE1,
// AE2, and AE7 plus every edge from the plan (KTD3), and grows with
// every new edge found. Test names document each tie-break decision.

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "anchor.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// Patch fixtures. Content lines are what identity hashes over; @@
// positions and index lines deliberately vary between rounds.

const patchMainV1 = `diff --git a/main.go b/main.go
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/main.go
+++ b/main.go
@@ -10,3 +10,4 @@ func main() {
 	a := 1
-	print(a)
+	fmt.Println(a)
+	fmt.Println("done")
 }
`

// Same content as patchMainV1 but the base shifted by 4 lines (a
// downstack fix restacked this branch): positions moved, content
// identical, index line rewritten.
const patchMainV1Restacked = `diff --git a/main.go b/main.go
index 3333333333333333333333333333333333333333..4444444444444444444444444444444444444444 100644
--- a/main.go
+++ b/main.go
@@ -14,3 +14,4 @@ func main() {
 	a := 1
-	print(a)
+	fmt.Println(a)
+	fmt.Println("done")
 }
`

// The hunk was rewritten: fmt.Println(a) became log.Println(a).
const patchMainV2 = `diff --git a/main.go b/main.go
index 1111111111111111111111111111111111111111..5555555555555555555555555555555555555555 100644
--- a/main.go
+++ b/main.go
@@ -10,3 +10,4 @@ func main() {
 	a := 1
-	print(a)
+	log.Println(a)
+	log.Println("done")
 }
`

// Whitespace-only difference from V1: an extra space crept in after
// the tab indent of the first added line.
const patchMainV1Whitespace = `diff --git a/main.go b/main.go
index 1111111111111111111111111111111111111111..6666666666666666666666666666666666666666 100644
--- a/main.go
+++ b/main.go
@@ -10,3 +10,4 @@ func main() {
 	a := 1
-	print(a)
+	 fmt.Println(a)
+	fmt.Println("done")
 }
`

// V1 content under a renamed path (rename + the same change).
const patchRenamed = `diff --git a/pkg/renamed.go b/pkg/renamed.go
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/pkg/renamed.go
+++ b/pkg/renamed.go
@@ -10,3 +10,4 @@ func main() {
 	a := 1
-	print(a)
+	fmt.Println(a)
+	fmt.Println("done")
 }
`

// Identical hunk content in two different files.
const patchTwoFilesSameHunk = `diff --git a/main.go b/main.go
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/main.go
+++ b/main.go
@@ -10,3 +10,4 @@ func main() {
 	a := 1
-	print(a)
+	fmt.Println(a)
+	fmt.Println("done")
 }
diff --git a/copy.go b/copy.go
index 7777777777777777777777777777777777777777..8888888888888888888888888888888888888888 100644
--- a/copy.go
+++ b/copy.go
@@ -10,3 +10,4 @@ func main() {
 	a := 1
-	print(a)
+	fmt.Println(a)
+	fmt.Println("done")
 }
`

// Two identical hunks within ONE file, first at new-line 10, second at
// new-line 100.
const patchDupHunksNear = `diff --git a/main.go b/main.go
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/main.go
+++ b/main.go
@@ -10,2 +10,2 @@ func a() {
 	x := 1
-	old()
+	new()
@@ -100,2 +100,2 @@ func b() {
 	x := 1
-	old()
+	new()
`

// The same two hunks, both shifted down (+10 and +10).
const patchDupHunksShifted = `diff --git a/main.go b/main.go
index 1111111111111111111111111111111111111111..9999999999999999999999999999999999999999 100644
--- a/main.go
+++ b/main.go
@@ -20,2 +20,2 @@ func a() {
 	x := 1
-	old()
+	new()
@@ -110,2 +110,2 @@ func b() {
 	x := 1
-	old()
+	new()
`

// Two-hunk file: first hunk will be rewritten in round 2, second stays.
const patchTwoHunksV1 = `diff --git a/multi.go b/multi.go
index aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 100644
--- a/multi.go
+++ b/multi.go
@@ -5,2 +5,2 @@ func first() {
 	setup()
-	oldFirst()
+	newFirst()
@@ -50,2 +50,2 @@ func second() {
 	setup()
-	oldSecond()
+	newSecond()
`

const patchTwoHunksV2 = `diff --git a/multi.go b/multi.go
index aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..cccccccccccccccccccccccccccccccccccccccc 100644
--- a/multi.go
+++ b/multi.go
@@ -5,2 +5,2 @@ func first() {
 	setup()
-	oldFirst()
+	rewrittenFirst()
@@ -50,2 +50,2 @@ func second() {
 	setup()
-	oldSecond()
+	newSecond()
`

func mainFile(content string) store.NewRoundFile {
	return store.NewRoundFile{Path: "main.go", Status: store.FileModified, OldContent: []byte("old\n"), NewContent: []byte(content)}
}

type fixture struct {
	s      *store.Store
	review *store.Review
	engine *Engine
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	s := openStore(t)
	r, err := s.CreateReview("/repo", "main", nil)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{s: s, review: r, engine: New()}
}

func (f *fixture) round(t *testing.T, patch string, files ...store.NewRoundFile) *store.Round {
	t.Helper()
	round, err := f.s.CreateRound(f.review.ID, patch, files)
	if err != nil {
		t.Fatal(err)
	}
	return round
}

// thread creates a thread anchored in round with the given anchor; the
// draft flag mirrors R21 (drafts follow identical rules).
func (f *fixture) thread(t *testing.T, round *store.Round, a store.Anchor, draft bool) *store.Thread {
	t.Helper()
	th, _, err := f.s.CreateThread(f.review.ID, round.ID, a, store.RoleReviewer, "note", draft)
	if err != nil {
		t.Fatal(err)
	}
	return th
}

func (f *fixture) recompute(t *testing.T, prev, next *store.Round) {
	t.Helper()
	if err := f.engine.Recompute(f.s, f.review.ID, prev.ID, next.ID); err != nil {
		t.Fatalf("Recompute: %v", err)
	}
}

func (f *fixture) anchorIn(t *testing.T, threadID int64, round *store.Round) *store.ThreadAnchor {
	t.Helper()
	anchors, err := f.s.AnchorsForRound(round.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range anchors {
		if a.ThreadID == threadID {
			return a
		}
	}
	t.Fatalf("thread %d has no anchor in round %d — threads must never vanish", threadID, round.Seq)
	return nil
}

// --- the table: carry-over across a round pair ---

func TestCarryOverTable(t *testing.T) {
	intp := func(v int) *int { return &v }

	cases := []struct {
		name      string
		patch1    string
		files1    []store.NewRoundFile
		anchor    store.Anchor
		patch2    string
		files2    []store.NewRoundFile
		wantState string
		wantPath  string
		wantLine  int
		wantStart *int
	}{
		{
			// AE1 (Covers AE1): a downstack fix restacked this branch;
			// patch content is identical on a new base.
			name:   "AE1_restack_identical_content_on_new_base_stays_live",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11}, // fmt.Println(a)
			patch2: patchMainV1Restacked, files2: []store.NewRoundFile{mainFile("v1")},
			wantState: store.AnchorLive, wantPath: "main.go", wantLine: 15,
		},
		{
			// AE2 (Covers AE2): the agent rewrote the hunk.
			name:   "AE2_rewritten_hunk_goes_outdated",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: patchMainV2, files2: []store.NewRoundFile{mainFile("v2")},
			wantState: store.AnchorOutdated, wantPath: "main.go", wantLine: 11,
		},
		{
			name:   "deletions_side_anchor_follows_old_file_positions",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideDeletions, Line: 11}, // print(a)
			patch2: patchMainV1Restacked, files2: []store.NewRoundFile{mainFile("v1")},
			wantState: store.AnchorLive, wantPath: "main.go", wantLine: 15,
		},
		{
			// R9: a rename alone never outdates a thread.
			name:   "rename_with_unchanged_content_stays_live_at_new_path",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: patchRenamed,
			files2: []store.NewRoundFile{{
				Path: "pkg/renamed.go", OldPath: "main.go", Status: store.FileRenamed,
				OldContent: []byte("old\n"), NewContent: []byte("v1"),
			}},
			wantState: store.AnchorLive, wantPath: "pkg/renamed.go", wantLine: 11,
		},
		{
			// R22: the file left the diff entirely (agent reverted it).
			name:   "file_gone_from_diff_goes_outdated_but_reachable",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: patchTwoHunksV1, files2: []store.NewRoundFile{{Path: "multi.go", Status: store.FileModified, NewContent: []byte("x")}},
			wantState: store.AnchorOutdated, wantPath: "main.go", wantLine: 11,
		},
		{
			// Tie-break: candidates are confined to the (rename-mapped)
			// same path — the flowchart sends deleted paths to
			// outdated even when an identical hunk exists elsewhere.
			name:   "identical_hunks_in_two_files_anchor_to_the_same_path_one",
			patch1: patchTwoFilesSameHunk, files1: []store.NewRoundFile{mainFile("v1"), {Path: "copy.go", Status: store.FileModified, NewContent: []byte("c")}},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: patchTwoFilesSameHunk, files2: []store.NewRoundFile{mainFile("v1"), {Path: "copy.go", Status: store.FileModified, NewContent: []byte("c")}},
			wantState: store.AnchorLive, wantPath: "main.go", wantLine: 11,
		},
		{
			// Context shifted: same hunk, new position within the file.
			name:   "hunk_moved_within_file_stays_live",
			patch1: patchDupHunksNear, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 101}, // new() in second hunk
			patch2: patchDupHunksShifted, files2: []store.NewRoundFile{mainFile("v1b")},
			wantState: store.AnchorLive, wantPath: "main.go", wantLine: 111,
		},
		{
			// Tie-break documented: among same-path hash matches, the
			// nearest start wins.
			name:   "duplicate_hunks_in_one_file_resolve_to_nearest_position",
			patch1: patchDupHunksNear, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: patchDupHunksShifted, files2: []store.NewRoundFile{mainFile("v1b")},
			wantState: store.AnchorLive, wantPath: "main.go", wantLine: 21,
		},
		{
			// Documented choice: whitespace-only differences change the
			// content, so the thread goes outdated (KTD3 conservative).
			name:   "whitespace_only_change_outdates_by_default",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: patchMainV1Whitespace, files2: []store.NewRoundFile{mainFile("v1ws")},
			wantState: store.AnchorOutdated, wantPath: "main.go", wantLine: 11,
		},
		{
			// Per-hunk granularity: rewriting hunk 1 must not outdate a
			// thread on hunk 2.
			name:   "unchanged_second_hunk_survives_first_hunk_rewrite",
			patch1: patchTwoHunksV1, files1: []store.NewRoundFile{{Path: "multi.go", Status: store.FileModified, NewContent: []byte("m1")}},
			anchor: store.Anchor{Path: "multi.go", Side: store.SideAdditions, Line: 51}, // newSecond()
			patch2: patchTwoHunksV2, files2: []store.NewRoundFile{{Path: "multi.go", Status: store.FileModified, NewContent: []byte("m2")}},
			wantState: store.AnchorLive, wantPath: "multi.go", wantLine: 51,
		},
		{
			// KTD12: an empty diff is a valid round; every thread goes
			// outdated, nothing crashes, nothing vanishes.
			name:   "empty_diff_round_outdates_everything",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11},
			patch2: "", files2: nil,
			wantState: store.AnchorOutdated, wantPath: "main.go", wantLine: 11,
		},
		{
			// A range comment keeps its span: both ends shift together.
			name:   "range_anchor_shifts_start_and_end_together",
			patch1: patchMainV1, files1: []store.NewRoundFile{mainFile("v1")},
			anchor: store.Anchor{Path: "main.go", Side: store.SideAdditions, StartLine: intp(10), Line: 12},
			patch2: patchMainV1Restacked, files2: []store.NewRoundFile{mainFile("v1")},
			wantState: store.AnchorLive, wantPath: "main.go", wantLine: 16, wantStart: intp(14),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			r1 := f.round(t, tc.patch1, tc.files1...)
			th := f.thread(t, r1, tc.anchor, false)
			r2 := f.round(t, tc.patch2, tc.files2...)
			f.recompute(t, r1, r2)

			got := f.anchorIn(t, th.ID, r2)
			if got.State != tc.wantState {
				t.Errorf("state = %s, want %s", got.State, tc.wantState)
			}
			if got.Path != tc.wantPath {
				t.Errorf("path = %s, want %s", got.Path, tc.wantPath)
			}
			if got.Line != tc.wantLine {
				t.Errorf("line = %d, want %d", got.Line, tc.wantLine)
			}
			if tc.wantStart != nil {
				if got.StartLine == nil || *got.StartLine != *tc.wantStart {
					t.Errorf("startLine = %v, want %d", got.StartLine, *tc.wantStart)
				}
			}

			// History is never lost (AE2): the round-1 anchor is intact.
			prev := f.anchorIn(t, th.ID, r1)
			if prev.Path != tc.anchor.Path || prev.Line != tc.anchor.Line || prev.State != store.AnchorLive {
				t.Errorf("round-1 anchor mutated: %+v", prev)
			}
		})
	}
}

// AE7 (Covers AE7): drafts carry across rounds under the same rules —
// live on unchanged hunks, outdated on changed ones, never lost, and
// round creation never blocks on them.
func TestAE7DraftsCarryAcrossRounds(t *testing.T) {
	f := newFixture(t)
	r1 := f.round(t, patchTwoHunksV1, store.NewRoundFile{Path: "multi.go", Status: store.FileModified, NewContent: []byte("m1")})

	draftOnChanged := f.thread(t, r1, store.Anchor{Path: "multi.go", Side: store.SideAdditions, Line: 6}, true)
	draftOnUnchanged := f.thread(t, r1, store.Anchor{Path: "multi.go", Side: store.SideAdditions, Line: 51}, true)

	// Round creation is not blocked by pending drafts.
	r2 := f.round(t, patchTwoHunksV2, store.NewRoundFile{Path: "multi.go", Status: store.FileModified, NewContent: []byte("m2")})
	f.recompute(t, r1, r2)

	changed := f.anchorIn(t, draftOnChanged.ID, r2)
	if changed.State != store.AnchorOutdated {
		t.Errorf("draft on rewritten hunk: state = %s, want outdated", changed.State)
	}
	unchanged := f.anchorIn(t, draftOnUnchanged.ID, r2)
	if unchanged.State != store.AnchorLive || unchanged.Line != 51 {
		t.Errorf("draft on unchanged hunk: %+v, want live at 51", unchanged)
	}

	// Both drafts still exist and are still drafts.
	for _, th := range []*store.Thread{draftOnChanged, draftOnUnchanged} {
		comments, err := f.s.CommentsForThread(th.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(comments) != 1 || !comments[0].Draft {
			t.Errorf("draft comment lost or promoted: %+v", comments)
		}
	}
}

// GitHub parity: once outdated, a thread stays outdated even if the
// original content reappears in a later round.
func TestOutdatedThreadsAreNotResurrected(t *testing.T) {
	f := newFixture(t)
	r1 := f.round(t, patchMainV1, mainFile("v1"))
	th := f.thread(t, r1, store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 11}, false)

	r2 := f.round(t, patchMainV2, mainFile("v2"))
	f.recompute(t, r1, r2)
	if a := f.anchorIn(t, th.ID, r2); a.State != store.AnchorOutdated {
		t.Fatalf("setup: expected outdated in round 2, got %s", a.State)
	}

	// Round 3 restores the original content verbatim.
	r3 := f.round(t, patchMainV1, mainFile("v1"))
	f.recompute(t, r2, r3)
	if a := f.anchorIn(t, th.ID, r3); a.State != store.AnchorOutdated {
		t.Errorf("outdated thread resurrected in round 3: %+v", a)
	}
}

// A comment on a line outside any hunk (expanded context, R25): live
// while the side's blob is byte-identical across rounds, outdated as
// soon as it differs.
func TestAnchorOutsideHunksFollowsBlobIdentity(t *testing.T) {
	f := newFixture(t)
	content := []byte("package main\n\nfunc untouched() {}\n")

	r1 := f.round(t, patchMainV1, store.NewRoundFile{Path: "main.go", Status: store.FileModified, OldContent: []byte("o"), NewContent: content})
	th := f.thread(t, r1, store.Anchor{Path: "main.go", Side: store.SideAdditions, Line: 3}, false) // context line

	// Round 2: same blob (identical content), different hunk elsewhere.
	r2 := f.round(t, patchMainV2, store.NewRoundFile{Path: "main.go", Status: store.FileModified, OldContent: []byte("o"), NewContent: content})
	f.recompute(t, r1, r2)
	if a := f.anchorIn(t, th.ID, r2); a.State != store.AnchorLive || a.Line != 3 {
		t.Errorf("unchanged blob: %+v, want live at 3", a)
	}

	// Round 3: the blob itself changed.
	r3 := f.round(t, patchMainV2, store.NewRoundFile{Path: "main.go", Status: store.FileModified, OldContent: []byte("o"), NewContent: []byte("package main\n\nfunc touched() {}\n")})
	f.recompute(t, r2, r3)
	if a := f.anchorIn(t, th.ID, r3); a.State != store.AnchorOutdated {
		t.Errorf("changed blob: %+v, want outdated", a)
	}
}
