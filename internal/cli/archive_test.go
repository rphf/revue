package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

	for _, args := range [][]string{{}, {"--landed", "--all"}, {"x"}, {"1", "--landed"}} {
		if code, _ := h.run(h.cmdArchive, args...); code != ExitValidation {
			t.Fatalf("archive %v = %d, want %d", args, code, ExitValidation)
		}
	}
	if code, _ := h.run(h.cmdArchive, "999"); code != ExitValidation {
		t.Fatalf("archive of an unknown thread = %d", code)
	}

	gittest.Git(t, h.repo, "commit", "-qam", "fix")
	// The server re-reads HEAD and the diff at most every half second.
	want := fmt.Sprintf("landed: %d\n", id)
	for deadline := time.Now().Add(3 * time.Second); ; {
		if out := h.feedback(0); strings.HasSuffix(out, want) {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("feedback without %q: %s", want, out)
		}
		time.Sleep(100 * time.Millisecond)
	}

	if code, out := h.run(h.cmdArchive, "--landed"); code != ExitOK || out != fmt.Sprintf("archived: %d\n", id) {
		t.Fatalf("archive --landed = %d %q", code, out)
	}
	if out := h.feedback(0); strings.Contains(out, "#") {
		t.Fatalf("feedback after archiving = %s", out)
	}
	if code, out := h.run(h.cmdArchive, "--landed"); code != ExitOK || out != "archived: none\n" {
		t.Fatalf("archive with nothing landed = %d %q", code, out)
	}

	if code, _ := h.run(h.cmdUnarchive); code != ExitValidation {
		t.Fatalf("unarchive without an id = %d", code)
	}
	if code, out := h.run(h.cmdUnarchive, fmt.Sprint(id)); code != ExitOK || out != "" {
		t.Fatalf("unarchive = %d %q", code, out)
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
