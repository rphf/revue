package anchor

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// Placement is built test-first: this table encodes the acceptance
// examples of the first plan and every edge found since. Test names
// document each tie-break decision.

// Patch fixtures. Content lines are what identity hashes over; @@
// positions and index lines deliberately vary between captures.

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

// Two-hunk file: the first hunk gets rewritten, the second stays.
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

// file is a capture entry for the tests: path, rename source, and the
// contents of both sides ("" for an absent side).
type file struct {
	path, oldPath string
	old, new      string
}

func mainFile(content string) file {
	return file{path: "main.go", old: "old\n", new: content}
}

func hash(content string) string {
	if content == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func target(patch string, files ...file) *Target {
	t := NewTarget(ParsePatch(patch))
	for _, f := range files {
		t.AddFile(f.path, f.oldPath, hash(f.old), hash(f.new))
	}
	return t
}

// origin builds what a thread would remember when written at
// path:line on side in the capture (patch, files).
func origin(patch string, files []file, path, side string, line int, start *int) Origin {
	o := Origin{Path: path, Side: side, Line: line, StartLine: start}
	if h := Find(ParsePatch(patch), path, side, line); h != nil {
		o.HunkHash, o.HunkStart = h.Hash, h.Start(side)
	}
	for _, f := range files {
		if f.path != path {
			continue
		}
		if side == SideDeletions {
			o.SideBlob = hash(f.old)
		} else {
			o.SideBlob = hash(f.new)
		}
	}
	return o
}

func TestLocateTable(t *testing.T) {
	intp := func(v int) *int { return &v }

	cases := []struct {
		name      string
		patch1    string
		files1    []file
		path      string
		side      string
		line      int
		start     *int
		patch2    string
		files2    []file
		wantState string
		wantPath  string
		wantLine  int
		wantStart *int
	}{
		{
			// A downstack fix restacked this branch; patch content is
			// identical on a new base.
			name:   "restack_identical_content_on_new_base_stays_live",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11, // fmt.Println(a)
			patch2: patchMainV1Restacked, files2: []file{mainFile("v1")},
			wantState: Live, wantPath: "main.go", wantLine: 15,
		},
		{
			name:   "rewritten_hunk_goes_outdated_at_its_origin",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11,
			patch2: patchMainV2, files2: []file{mainFile("v2")},
			wantState: Outdated, wantPath: "main.go", wantLine: 11,
		},
		{
			name:   "deletions_side_anchor_follows_old_file_positions",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideDeletions, line: 11, // print(a)
			patch2: patchMainV1Restacked, files2: []file{mainFile("v1")},
			wantState: Live, wantPath: "main.go", wantLine: 15,
		},
		{
			// A rename alone never outdates a thread.
			name:   "rename_with_unchanged_content_stays_live_at_new_path",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11,
			patch2:    patchRenamed,
			files2:    []file{{path: "pkg/renamed.go", oldPath: "main.go", old: "old\n", new: "v1"}},
			wantState: Live, wantPath: "pkg/renamed.go", wantLine: 11,
		},
		{
			// The file left the diff entirely (reverted or committed).
			name:   "file_gone_from_diff_goes_outdated_but_keeps_its_origin",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11,
			patch2: patchTwoHunksV1, files2: []file{{path: "multi.go", new: "x"}},
			wantState: Outdated, wantPath: "main.go", wantLine: 11,
		},
		{
			// Candidates are confined to the (rename-mapped) same path:
			// a deleted path goes outdated even when an identical hunk
			// exists elsewhere.
			name:   "identical_hunks_in_two_files_anchor_to_the_same_path_one",
			patch1: patchTwoFilesSameHunk, files1: []file{mainFile("v1"), {path: "copy.go", new: "c"}},
			path: "main.go", side: SideAdditions, line: 11,
			patch2: patchTwoFilesSameHunk, files2: []file{mainFile("v1"), {path: "copy.go", new: "c"}},
			wantState: Live, wantPath: "main.go", wantLine: 11,
		},
		{
			// Context shifted: same hunk, new position within the file.
			name:   "hunk_moved_within_file_stays_live",
			patch1: patchDupHunksNear, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 101, // new() in second hunk
			patch2: patchDupHunksShifted, files2: []file{mainFile("v1b")},
			wantState: Live, wantPath: "main.go", wantLine: 111,
		},
		{
			// Among same-path hash matches, the nearest start wins.
			name:   "duplicate_hunks_in_one_file_resolve_to_nearest_position",
			patch1: patchDupHunksNear, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11,
			patch2: patchDupHunksShifted, files2: []file{mainFile("v1b")},
			wantState: Live, wantPath: "main.go", wantLine: 21,
		},
		{
			// Whitespace-only differences change the content, so the
			// thread goes outdated (conservative by design).
			name:   "whitespace_only_change_outdates_by_default",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11,
			patch2: patchMainV1Whitespace, files2: []file{mainFile("v1ws")},
			wantState: Outdated, wantPath: "main.go", wantLine: 11,
		},
		{
			// Per-hunk granularity: rewriting hunk 1 must not outdate a
			// thread on hunk 2.
			name:   "unchanged_second_hunk_survives_first_hunk_rewrite",
			patch1: patchTwoHunksV1, files1: []file{{path: "multi.go", new: "m1"}},
			path: "multi.go", side: SideAdditions, line: 51, // newSecond()
			patch2: patchTwoHunksV2, files2: []file{{path: "multi.go", new: "m2"}},
			wantState: Live, wantPath: "multi.go", wantLine: 51,
		},
		{
			// An empty diff: every thread is outdated, nothing crashes.
			name:   "empty_diff_outdates_everything",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 11,
			patch2: "", files2: nil,
			wantState: Outdated, wantPath: "main.go", wantLine: 11,
		},
		{
			// A range comment keeps its span: both ends shift together.
			name:   "range_anchor_shifts_start_and_end_together",
			patch1: patchMainV1, files1: []file{mainFile("v1")},
			path: "main.go", side: SideAdditions, line: 12, start: intp(10),
			patch2: patchMainV1Restacked, files2: []file{mainFile("v1")},
			wantState: Live, wantPath: "main.go", wantLine: 16, wantStart: intp(14),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := origin(tc.patch1, tc.files1, tc.path, tc.side, tc.line, tc.start)
			got := target(tc.patch2, tc.files2...).Locate(o)
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
			if got.Side != tc.side {
				t.Errorf("side = %s, want %s", got.Side, tc.side)
			}
		})
	}
}

// Position is derived per capture, so a thread outdated by one edit is
// live again once the content is back: an agent mid-edit makes hunks
// flicker and must not strand threads.
func TestOutdatedThreadsComeBackWithTheirContent(t *testing.T) {
	o := origin(patchMainV1, []file{mainFile("v1")}, "main.go", SideAdditions, 11, nil)
	if got := target(patchMainV2, mainFile("v2")).Locate(o); got.State != Outdated {
		t.Fatalf("rewritten: state = %s, want outdated", got.State)
	}
	if got := target(patchMainV1Restacked, mainFile("v1")).Locate(o); got.State != Live || got.Line != 15 {
		t.Errorf("content restored: %+v, want live at 15", got)
	}
}

// A comment on a line outside any hunk (expanded context): live while
// the side's content is byte-identical, outdated as soon as it differs.
func TestAnchorOutsideHunksFollowsBlobIdentity(t *testing.T) {
	content := "package main\n\nfunc untouched() {}\n"
	files := []file{{path: "main.go", old: "o", new: content}}
	o := origin(patchMainV1, files, "main.go", SideAdditions, 3, nil) // context line
	if o.HunkHash != "" {
		t.Fatalf("setup: line 3 should be outside the hunk, got hash %q", o.HunkHash)
	}

	// Same content, a different hunk elsewhere.
	if got := target(patchMainV2, files...).Locate(o); got.State != Live || got.Line != 3 {
		t.Errorf("unchanged content: %+v, want live at 3", got)
	}
	// The content itself changed.
	changed := []file{{path: "main.go", old: "o", new: "package main\n\nfunc touched() {}\n"}}
	if got := target(patchMainV2, changed...).Locate(o); got.State != Outdated {
		t.Errorf("changed content: %+v, want outdated", got)
	}
	// The file is gone from the diff.
	if got := target("").Locate(o); got.State != Outdated {
		t.Errorf("file gone: %+v, want outdated", got)
	}
}

func TestParsePatchCountsAndPaths(t *testing.T) {
	hunks := ParsePatch(patchTwoFilesSameHunk)
	if len(hunks) != 2 {
		t.Fatalf("hunks = %d, want 2", len(hunks))
	}
	if hunks[0].Path != "main.go" || hunks[1].Path != "copy.go" {
		t.Errorf("paths = %s, %s", hunks[0].Path, hunks[1].Path)
	}
	if hunks[0].Hash != hunks[1].Hash {
		t.Error("identical bodies should hash the same")
	}
	h := hunks[0]
	if h.OldStart != 10 || h.OldCount != 3 || h.NewStart != 10 || h.NewCount != 4 {
		t.Errorf("counts = -%d,%d +%d,%d", h.OldStart, h.OldCount, h.NewStart, h.NewCount)
	}
	if Find(hunks, "main.go", SideAdditions, 13) == nil || Find(hunks, "main.go", SideAdditions, 14) != nil {
		t.Error("Find bounds: line 13 is the last new line, 14 is outside")
	}
	if Find(hunks, "main.go", SideDeletions, 12) == nil || Find(hunks, "main.go", SideDeletions, 13) != nil {
		t.Error("Find bounds on the deletions side")
	}
}
