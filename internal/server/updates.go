package server

import (
	"net/http"
	"sync"
	"time"

	"github.com/rphf/revue/internal/release"
)

// updateCheckEvery spaces the lookups of the latest release; a failed
// lookup waits as long, so an offline machine is not asked again.
const updateCheckEvery = 24 * time.Hour

// updates tells the page when a newer release than the running one is
// out. A local build never looks: whoever built it picks its version.
type updates struct {
	current  string
	releases string
	client   *http.Client

	mu      sync.Mutex
	latest  string
	checked time.Time
}

func newUpdates(current string) *updates {
	return &updates{
		current:  current,
		releases: release.URL,
		client:   &http.Client{Timeout: 10 * time.Second},
	}
}

// available returns the latest release tag when it is newer than the
// running build, and "" otherwise.
func (u *updates) available() string {
	if release.LocalBuild(u.current) {
		return ""
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if time.Since(u.checked) >= updateCheckEvery {
		u.checked = time.Now()
		if latest, err := release.Latest(u.client, u.releases); err == nil {
			u.latest = latest
		}
	}
	if u.latest != "" && release.Newer(u.latest, u.current) {
		return u.latest
	}
	return ""
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{"version": s.updates.current}
	if latest := s.updates.available(); latest != "" {
		body["latest"] = latest
	}
	writeJSON(w, http.StatusOK, body)
}
