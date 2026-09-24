package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rphf/revue/internal/gittest"
	"github.com/rphf/revue/internal/server"
)

func TestArchiveValidatesAndArchivesLandedThreads(t *testing.T) {
	h := newHarness(t)
	h.modify(v2)
	id := h.reviewerDraft(4, "rename")
	h.reviewerSend("")

	for _, args := range [][]string{{}, {"--landed", "--all"}, {"--thread", "x"}} {
		if code, _ := h.run(h.cmdArchive, args...); code != ExitValidation {
			t.Fatalf("archive %v = %d, want %d", args, code, ExitValidation)
		}
	}
	if code, _ := h.run(h.cmdArchive, "--thread", "999"); code != ExitValidation {
		t.Fatalf("archive of an unknown thread = %d", code)
	}

	gittest.Git(t, h.repo, "commit", "-qam", "fix")
	// The server re-reads HEAD and the diff at most every half second.
	var fb struct {
		Landed []int64 `json:"landed"`
	}
	var out string
	for deadline := time.Now().Add(3 * time.Second); ; {
		_, out = h.run(h.cmdFeedback)
		if err := json.Unmarshal([]byte(out), &fb); err == nil && slices.Equal(fb.Landed, []int64{id}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("feedback landed = %v: %s", fb.Landed, out)
		}
		time.Sleep(100 * time.Millisecond)
	}

	code, out := h.run(h.cmdArchive, "--landed")
	var res struct {
		Archived []int64 `json:"archived"`
	}
	if code != ExitOK || json.Unmarshal([]byte(out), &res) != nil || !slices.Equal(res.Archived, []int64{id}) {
		t.Fatalf("archive --landed = %d %s", code, out)
	}
	_, out = h.run(h.cmdFeedback)
	var after feedback
	if err := json.Unmarshal([]byte(out), &after); err != nil || len(after.Threads) != 0 {
		t.Fatalf("feedback after archiving = %s", out)
	}

	if code, _ := h.run(h.cmdUnarchive); code != ExitValidation {
		t.Fatalf("unarchive without --thread = %d", code)
	}
	if code, out := h.run(h.cmdUnarchive, "--thread", "1"); code != ExitOK {
		t.Fatalf("unarchive = %d %s", code, out)
	}
}

func TestPruneRemovesDataOfRepositoriesThatAreGone(t *testing.T) {
	base := t.TempDir()
	t.Setenv("REVUE_DATA_DIR", base)
	gone := initRepo(t)
	kept := initRepo(t)
	for _, repo := range []string{gone, kept} {
		srv, err := server.Start(server.Config{RepoRoot: repo})
		if err != nil {
			t.Fatal(err)
		}
		shutdown(t, srv)
	}
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(base, "unknown")
	if err := os.MkdirAll(unknown, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unknown, "revue.db"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	var out, errOut strings.Builder
	if code := cmdPrune([]string{"--dry-run"}, &out, &errOut); code != ExitOK || !strings.Contains(out.String(), "would remove") {
		t.Fatalf("dry run = %d %q %q", code, out.String(), errOut.String())
	}
	goneDir, _ := server.DataDir(gone)
	if _, err := os.Stat(goneDir); err != nil {
		t.Fatalf("dry run removed %s", goneDir)
	}

	out.Reset()
	if code := cmdPrune(nil, &out, &errOut); code != ExitOK {
		t.Fatalf("prune = %d %q", code, errOut.String())
	}
	if !strings.Contains(out.String(), "removed "+goneDir) || !strings.Contains(out.String(), "kept "+unknown) {
		t.Fatalf("prune output = %q", out.String())
	}
	if _, err := os.Stat(goneDir); !os.IsNotExist(err) {
		t.Fatalf("data of the gone repo still there: %v", err)
	}
	keptDir, _ := server.DataDir(kept)
	if _, err := os.Stat(keptDir); err != nil {
		t.Fatalf("data of an existing repo removed: %v", err)
	}
}

func shutdown(t *testing.T, srv *server.Server) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}
