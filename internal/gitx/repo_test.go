package gitx

import (
	"strings"
	"testing"

	"github.com/rphf/revue/internal/gittest"
)

func TestHeadNamesCommitAndBranch(t *testing.T) {
	dir := gittest.Init(t)
	if c, b := Head(dir); c != "" || b != "" {
		t.Fatalf("unborn HEAD = %q %q", c, b)
	}
	write(t, dir, "a.txt", "a\n")
	commitAll(t, dir, "one")
	first := strings.TrimSpace(gittest.Git(t, dir, "rev-parse", "HEAD"))
	if c, b := Head(dir); c != first || b != "main" {
		t.Fatalf("Head = %q %q", c, b)
	}
	gittest.Git(t, dir, "checkout", "-q", "--detach")
	if c, b := Head(dir); c != first || b != "" {
		t.Fatalf("detached Head = %q %q", c, b)
	}
}

func TestAncestryTipsAndDefaultBranch(t *testing.T) {
	dir := gittest.Init(t)
	write(t, dir, "a.txt", "a\n")
	commitAll(t, dir, "one")
	one := strings.TrimSpace(gittest.Git(t, dir, "rev-parse", "HEAD"))
	gittest.Git(t, dir, "checkout", "-q", "-b", "feat")
	write(t, dir, "a.txt", "b\n")
	commitAll(t, dir, "two")
	two := strings.TrimSpace(gittest.Git(t, dir, "rev-parse", "HEAD"))

	if !IsAncestor(dir, one, two) || IsAncestor(dir, two, one) || IsAncestor(dir, "deadbeef", two) {
		t.Fatal("ancestry wrong")
	}
	if tip, ok := BranchTip(dir, "feat"); !ok || tip != two {
		t.Fatalf("tip of feat = %q %v", tip, ok)
	}
	if _, ok := BranchTip(dir, "gone"); ok {
		t.Fatal("a missing branch has a tip")
	}
	if ref, name := DefaultBranch(dir); ref != "main" || name != "main" {
		t.Fatalf("default = %q %q", ref, name)
	}

	log, err := Log(dir, "main..feat", 10)
	if err != nil || len(log) != 1 || log[0].Hash != two || log[0].Subject != "two" || log[0].Date.IsZero() {
		t.Fatalf("log = %+v, %v", log, err)
	}
	got, err := Commits(dir, []string{two, strings.Repeat("d", 40), one})
	if err != nil || len(got) != 2 || got[0].Hash != two || got[1].Hash != one {
		t.Fatalf("commits = %+v, %v", got, err)
	}
	if none, err := Commits(dir, []string{strings.Repeat("d", 40)}); err != nil || len(none) != 0 {
		t.Fatalf("only missing commits = %+v, %v", none, err)
	}
	if !IsWorkingTree(nil) || !IsWorkingTree([]string{"--", "a"}) || IsWorkingTree([]string{"main"}) || IsWorkingTree([]string{"--staged"}) {
		t.Fatal("IsWorkingTree wrong")
	}
}
