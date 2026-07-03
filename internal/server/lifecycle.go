package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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
	if st == nil || st.Port == 0 || st.Token == "" {
		return false
	}
	req, err := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/healthz", st.Port), nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+st.Token)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		OK bool `json:"ok"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false
	}
	return body.OK
}

// Ensure returns a healthy server's state for the repo, starting one
// as a detached process if none is running (KTD5: any CLI command
// starts the server if absent).
func Ensure(repoRoot string) (*State, error) {
	dataDir, err := DataDir(repoRoot)
	if err != nil {
		return nil, err
	}
	if st, err := ReadState(dataDir); err == nil && Healthy(st) {
		return st, nil
	}

	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(filepath.Join(dataDir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return nil, err
		}
		logFile, err = os.OpenFile(filepath.Join(dataDir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "__serve", "--repo", repoRoot)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = detachSysProcAttr()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	// Detach: the server outlives this CLI invocation.
	go cmd.Wait()

	// Wait for the state file to reflect the new server and turn healthy.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st, err := ReadState(dataDir); err == nil && Healthy(st) {
			return st, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("server for %s did not become healthy in time (see %s)", repoRoot, filepath.Join(dataDir, "server.log"))
}

// BaseURL renders the browser/CLI base URL for a state.
func (st *State) BaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", st.Port)
}

// AuthURL renders the one-time token exchange URL that lands on next.
func (st *State) AuthURL(next string) string {
	return fmt.Sprintf("%s/auth?token=%s&next=%s", st.BaseURL(), st.Token, next)
}
