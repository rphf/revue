package server

import (
	"os"
	"slices"
	"testing"
	"time"
)

func TestSessionReposAreRecordedOncePerSession(t *testing.T) {
	t.Setenv("REVUE_DATA_DIR", t.TempDir())
	if repos, err := SessionRepos("s1"); err != nil || repos != nil {
		t.Fatalf("repos of an unknown session = %v, %v", repos, err)
	}
	for _, step := range []struct{ id, repo string }{
		{"s1", "/work/a"}, {"s1", "/work/b"}, {"s1", "/work/a"}, {"s2", "/work/c"},
	} {
		if err := RecordSession(step.id, step.repo); err != nil {
			t.Fatal(err)
		}
	}
	if repos, _ := SessionRepos("s1"); !slices.Equal(repos, []string{"/work/a", "/work/b"}) {
		t.Errorf("repos of s1 = %v, want a then b, once each", repos)
	}
	if repos, _ := SessionRepos("s2"); !slices.Equal(repos, []string{"/work/c"}) {
		t.Errorf("repos of s2 = %v, want only c", repos)
	}
}

func TestRecordSessionDropsSessionsLongGone(t *testing.T) {
	t.Setenv("REVUE_DATA_DIR", t.TempDir())
	if err := RecordSession("old", "/work/a"); err != nil {
		t.Fatal(err)
	}
	path, err := sessionPath("old")
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-sessionMaxAge - time.Hour)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}
	if err := RecordSession("new", "/work/b"); err != nil {
		t.Fatal(err)
	}
	if repos, _ := SessionRepos("old"); repos != nil {
		t.Errorf("repos of a session long gone = %v, want none", repos)
	}
	if repos, _ := SessionRepos("new"); len(repos) != 1 {
		t.Errorf("repos of the new session = %v", repos)
	}
}
