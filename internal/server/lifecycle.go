package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// repoKey hashes the repo path so per-repo data lives under the user
// data dir without writing anything inside the repo (KTD5).
func repoKey(repoRoot string) string {
	abs, err := filepath.Abs(repoRoot)
	if err != nil {
		abs = repoRoot
	}
	sum := sha256.Sum256([]byte(abs))
	return hex.EncodeToString(sum[:8])
}

// Healthy probes a recorded server state and reports whether a live
// revue server for this repo answers with the recorded token.
func Healthy(st *State) bool {
	_, ok := probe(st)
	return ok
}

// health is what a server's /healthz answers.
type health struct {
	OK    bool   `json:"ok"`
	Build string `json:"build"`
	// Pages counts the pages connected to the server.
	Pages int `json:"pages"`
}

// probe asks the recorded server for its health and build stamp.
func probe(st *State) (build string, ok bool) {
	h, ok := probeHealth(st)
	return h.Build, ok
}

func probeHealth(st *State) (health, bool) {
	if st == nil || st.Port == 0 || st.Token == "" {
		return health{}, false
	}
	req, err := http.NewRequest("GET", st.BaseURL()+"/healthz", nil)
	if err != nil {
		return health{}, false
	}
	req.Header.Set("Authorization", "Bearer "+st.Token)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return health{}, false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return health{}, false
	}
	var h health
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return health{}, false
	}
	return h, h.OK
}

// stopStale asks a server from another build to exit and waits for its
// port to fall silent, so the replacement can take the recorded port.
func stopStale(st *State) {
	if st.PID <= 0 {
		return
	}
	proc, err := os.FindProcess(st.PID)
	if err != nil {
		return
	}
	_ = terminateProcess(proc)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, alive := probe(st); !alive {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Running lists the servers that answer on their recorded port with
// their recorded token. State files of stopped servers stay on disk:
// they keep the port and token a revived server reuses.
func Running() ([]*State, error) {
	base, err := stateBase()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(base)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Probe every server at once; each slot keeps the directory order.
	found := make([]*State, len(entries))
	var wg sync.WaitGroup
	for i, e := range entries {
		if !e.IsDir() {
			continue
		}
		wg.Go(func() {
			st, err := ReadState(filepath.Join(base, e.Name()))
			if err == nil && Healthy(st) {
				found[i] = st
			}
		})
	}
	wg.Wait()
	var out []*State
	for _, st := range found {
		if st != nil {
			out = append(out, st)
		}
	}
	return out, nil
}

// Stop ends a running server and waits for it to go. It only signals a
// process that still answers with the recorded token, so a PID the
// system reused for another program is left alone.
func Stop(st *State) error {
	if !Healthy(st) {
		return nil
	}
	stopStale(st)
	if Healthy(st) {
		return fmt.Errorf("server on port %d (pid %d) did not stop", st.Port, st.PID)
	}
	return nil
}

// Ensure returns a healthy server's state for the repo, starting one
// as a detached process if none is running (KTD5: any CLI command
// starts the server if absent).
func Ensure(repoRoot string) (*State, error) {
	stateDir, err := StateDir(repoRoot)
	if err != nil {
		return nil, err
	}
	// Pages of a replaced server reconnect to its successor, which
	// waits for them before it reports that no page is open.
	reconnecting := false
	if st, err := ReadState(stateDir); err == nil {
		if h, alive := probeHealth(st); alive {
			if h.Build == BuildStamp() {
				return st, nil
			}
			// A server from another build keeps serving its own embedded
			// UI and API; after a rebuild or an upgrade it must go.
			reconnecting = h.Pages > 0
			stopStale(st)
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(filepath.Join(stateDir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	defer func() { _ = logFile.Close() }()

	args := []string{"__serve", "--repo", repoRoot}
	if reconnecting {
		args = append(args, "--pages-reconnecting")
	}
	cmd := exec.Command(exe, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = detachSysProcAttr()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	// Detach: the server outlives this CLI invocation.
	go func() { _ = cmd.Wait() }()

	// Wait for the state file to reflect the new server and turn healthy.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st, err := ReadState(stateDir); err == nil && Healthy(st) {
			return st, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("server for %s did not become healthy in time (see %s)", repoRoot, filepath.Join(stateDir, "server.log"))
}

// BaseURL renders the loopback base URL the CLI dials.
func (st *State) BaseURL() string {
	return "http://" + net.JoinHostPort(loopbackHost(st.Bind), strconv.Itoa(st.Port))
}

func (st *State) PublicBaseURL() string {
	if st.PublicURL != "" {
		return st.PublicURL
	}
	return st.BaseURL()
}

// AuthURL renders the one-time token exchange URL that lands on next.
func (st *State) AuthURL(next string) string {
	return fmt.Sprintf("%s/auth?token=%s&next=%s", st.PublicBaseURL(), st.Token, url.QueryEscape(next))
}
