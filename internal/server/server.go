// Package server is the per-repo revue server: domain HTTP API, SSE
// event stream, localhost security (R23), and on-demand process
// lifecycle (KTD5).
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/rphf/revue/internal/store"
)

// Anchor is the carry-over seam (KTD3): round creation calls it to map
// every thread's and draft's anchor from the previous round into the
// new one. The real engine lands in the anchor package (U8).
type Anchor interface {
	Recompute(tx *store.Store, reviewID, prevRoundID, newRoundID int64) error
}

// carryForwardAnchor is the Phase-1 stub: every anchor carries to the
// new round unchanged and live.
type carryForwardAnchor struct{}

func (carryForwardAnchor) Recompute(tx *store.Store, reviewID, prevRoundID, newRoundID int64) error {
	anchors, err := tx.AnchorsForRound(prevRoundID)
	if err != nil {
		return err
	}
	for _, a := range anchors {
		if err := tx.UpsertAnchor(a.ThreadID, newRoundID, a.Anchor, a.State, a.HunkHash); err != nil {
			return err
		}
	}
	return nil
}

type Config struct {
	RepoRoot    string
	DataDir     string        // when set, db AND state live under this one dir (tests, scripts)
	IdleTimeout time.Duration // 0 disables idle shutdown
	Anchor      Anchor        // nil selects the Phase-1 carry-forward stub
}

type Server struct {
	store    *store.Store
	repoRoot string
	token    string
	anchor   Anchor
	bus      *bus
	activity *activity

	http    *http.Server
	ln      net.Listener
	closing chan struct{} // signals streaming handlers to drain
	done    chan struct{} // closed when fully stopped
	once    sync.Once
}

// State is the per-repo state file contents (KTD5). The token is an
// API credential; the file is written 0600.
type State struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

// Per-repo directories follow the XDG base-directory convention (like
// nvim: config-style trees under the home dir, not ~/Library), keyed
// by a hash of the repo path — nothing is written inside the repo.
// REVUE_DATA_DIR overrides BOTH bases with a single root for tests
// and scripted runs that must not touch the real user dirs.

// xdgDir resolves one XDG base dir with its conventional fallback.
func xdgDir(envVar, fallback string) (string, error) {
	if v := os.Getenv(envVar); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, fallback), nil
}

// DataDir holds durable per-repo data (the reviews database):
// $XDG_DATA_HOME/revue/<key>, default ~/.local/share/revue/<key>.
func DataDir(repoRoot string) (string, error) {
	if base := os.Getenv("REVUE_DATA_DIR"); base != "" {
		return filepath.Join(base, repoKey(repoRoot)), nil
	}
	base, err := xdgDir("XDG_DATA_HOME", filepath.Join(".local", "share"))
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "revue", repoKey(repoRoot)), nil
}

// StateDir holds ephemeral per-repo runtime state (the server state
// file and log): $XDG_STATE_HOME/revue/<key>, default
// ~/.local/state/revue/<key>.
func StateDir(repoRoot string) (string, error) {
	if base := os.Getenv("REVUE_DATA_DIR"); base != "" {
		return filepath.Join(base, repoKey(repoRoot)), nil
	}
	base, err := xdgDir("XDG_STATE_HOME", filepath.Join(".local", "state"))
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "revue", repoKey(repoRoot)), nil
}

func statePath(stateDir string) string { return filepath.Join(stateDir, "state.json") }

// ReadState loads the state file if present.
func ReadState(stateDir string) (*State, error) {
	data, err := os.ReadFile(statePath(stateDir))
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func writeState(stateDir string, st *State) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	tmp := statePath(stateDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, statePath(stateDir))
}

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return hex.EncodeToString(b)
}

// Start opens the store, binds 127.0.0.1 (rebinding the recorded port
// first so open tab URLs survive restarts), writes the state file, and
// serves in the background.
func Start(cfg Config) (*Server, error) {
	dataDir, stateDir := cfg.DataDir, cfg.DataDir
	if cfg.DataDir == "" {
		var err error
		if dataDir, err = DataDir(cfg.RepoRoot); err != nil {
			return nil, err
		}
		if stateDir, err = StateDir(cfg.RepoRoot); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}

	// Reuse the recorded port and token on revival (KTD5): the port
	// keeps open-tab URLs working, the token keeps their cookies valid.
	prev, _ := ReadState(stateDir)
	token := newToken()
	if prev != nil && prev.Token != "" {
		token = prev.Token
	}

	var ln net.Listener
	var err error
	if prev != nil && prev.Port != 0 {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", prev.Port))
	}
	if ln == nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
	}

	st, err := store.Open(filepath.Join(dataDir, "revue.db"))
	if err != nil {
		ln.Close()
		return nil, err
	}

	anchor := cfg.Anchor
	if anchor == nil {
		anchor = carryForwardAnchor{}
	}

	s := &Server{
		store:    st,
		repoRoot: cfg.RepoRoot,
		token:    token,
		anchor:   anchor,
		bus:      newBus(),
		activity: newActivity(),
		closing:  make(chan struct{}),
		done:     make(chan struct{}),
	}
	s.ln = ln
	s.http = &http.Server{Handler: s.Handler()}

	port := ln.Addr().(*net.TCPAddr).Port
	if err := writeState(stateDir, &State{Port: port, Token: token, PID: os.Getpid()}); err != nil {
		st.Close()
		ln.Close()
		return nil, err
	}

	go s.http.Serve(ln)
	if cfg.IdleTimeout > 0 {
		go s.idleLoop(cfg.IdleTimeout)
	}
	return s, nil
}

func (s *Server) URL() string   { return "http://" + s.ln.Addr().String() }
func (s *Server) Token() string { return s.token }

// Done closes when the server has shut down (idle or explicit).
func (s *Server) Done() <-chan struct{} { return s.done }

func (s *Server) Shutdown(ctx context.Context) error {
	var err error
	s.once.Do(func() {
		// Streaming handlers (SSE, wait) hold connections open; signal
		// them to drain first or http.Shutdown would never return.
		close(s.closing)
		err = s.http.Shutdown(ctx)
		s.store.Close()
		close(s.done)
	})
	return err
}

// idleLoop shuts the server down after a quiet period with zero open
// SSE streams or wait long-polls (KTD5).
func (s *Server) idleLoop(timeout time.Duration) {
	interval := timeout / 4
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.closing:
			return
		case <-ticker.C:
			if s.activity.idleFor(timeout) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				s.Shutdown(ctx)
				cancel()
				return
			}
		}
	}
}

// activity tracks request recency and open streaming connections for
// the idle-shutdown gate.
type activity struct {
	mu    sync.Mutex
	last  time.Time
	conns int
}

func newActivity() *activity { return &activity{last: time.Now()} }

func (a *activity) touch() {
	a.mu.Lock()
	a.last = time.Now()
	a.mu.Unlock()
}

func (a *activity) connOpen() {
	a.mu.Lock()
	a.conns++
	a.mu.Unlock()
}

func (a *activity) connClose() {
	a.mu.Lock()
	a.conns--
	a.last = time.Now()
	a.mu.Unlock()
}

func (a *activity) idleFor(timeout time.Duration) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conns == 0 && time.Since(a.last) > timeout
}

// --- Security middleware (R23) ---

const authCookie = "revue_token"

// authorized checks the CLI header or the browser cookie against the
// server token in constant time.
func (s *Server) authorized(r *http.Request) bool {
	if h := r.Header.Get("Authorization"); h != "" {
		const prefix = "Bearer "
		if len(h) > len(prefix) && h[:len(prefix)] == prefix {
			return subtle.ConstantTimeCompare([]byte(h[len(prefix):]), []byte(s.token)) == 1
		}
		return false
	}
	if c, err := r.Cookie(authCookie); err == nil {
		return subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.token)) == 1
	}
	return false
}

// sameOrigin rejects cross-origin requests: an Origin header, when
// present, must match the server's own origin exactly (DNS-rebinding
// and CSRF defense; the CLI sends no Origin).
func (s *Server) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	host := s.ln.Addr().(*net.TCPAddr)
	allowed := []string{
		"http://127.0.0.1:" + strconv.Itoa(host.Port),
		"http://localhost:" + strconv.Itoa(host.Port),
	}
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

// handleAuth exchanges a one-time ?token= for an HttpOnly cookie and
// redirects to a token-free URL, so nothing secret persists in browser
// history (R23).
func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
		httpError(w, http.StatusUnauthorized, "unauthorized", "invalid token")
		return
	}
	next := r.URL.Query().Get("next")
	// Only same-site paths: no scheme/host redirects.
	if next == "" || next[0] != '/' || (len(next) > 1 && next[1] == '/') {
		next = "/"
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authCookie,
		Value:    s.token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	http.Redirect(w, r, next, http.StatusSeeOther)
}
