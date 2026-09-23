package cli

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rphf/revue/internal/server"
)

// buildRevue compiles the binary, since servers and stop act on real
// detached server processes, which an in-process test server is not.
func buildRevue(t *testing.T) string {
	t.Helper()
	root, err := exec.Command("go", "env", "GOMOD").Output()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "revue")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/revue")
	cmd.Dir = filepath.Dir(strings.TrimSpace(string(root)))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func TestServersListsAndStopStops(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary and starts servers")
	}
	bin := buildRevue(t)
	t.Setenv("REVUE_DATA_DIR", t.TempDir())
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("revue %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	repoA, repoB := initRepo(t), initRepo(t)
	t.Cleanup(func() { _ = exec.Command(bin, "stop", "--all").Run() })

	listed := func() []string {
		t.Helper()
		var out struct {
			Servers []serverView `json:"servers"`
		}
		if err := json.Unmarshal([]byte(run(repoA, "servers", "--json")), &out); err != nil {
			t.Fatal(err)
		}
		var repos []string
		for _, s := range out.Servers {
			repos = append(repos, s.Repo)
		}
		return repos
	}
	real := func(p string) string {
		r, err := filepath.EvalSymlinks(p)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	if got := run(repoA, "servers"); !strings.Contains(got, "no revue server is running") {
		t.Errorf("before any server: %q", got)
	}
	run(repoA, "open", "--no-browser")
	run(repoB, "open", "--no-browser")
	if got := listed(); len(got) != 2 {
		t.Fatalf("servers = %v, want both repos", got)
	}

	if got := run(repoA, "stop"); !strings.Contains(got, "stopped "+real(repoA)) {
		t.Errorf("stop in A: %q", got)
	}
	if got := listed(); len(got) != 1 || got[0] != real(repoB) {
		t.Errorf("after stopping A: %v, want only %s", got, real(repoB))
	}
	if got := run(repoA, "stop"); !strings.Contains(got, "no revue server is running for") {
		t.Errorf("second stop in A: %q", got)
	}

	if got := run(repoA, "stop", "--all"); !strings.Contains(got, "stopped "+real(repoB)) {
		t.Errorf("stop --all: %q", got)
	}
	if got := listed(); len(got) != 0 {
		t.Errorf("after stop --all: %v", got)
	}

	// A stopped server's state file stays, so the next start reuses its
	// port and token.
	stateDir, err := server.StateDir(real(repoA))
	if err != nil {
		t.Fatal(err)
	}
	if st, err := server.ReadState(stateDir); err != nil || st.Repo != real(repoA) {
		t.Errorf("state after stop = %+v, %v; want it kept, naming %s", st, err, real(repoA))
	}
}
