package server

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/rphf/revue/internal/store"
)

// settingDelivered is the cursor of the last feedback printed to the
// agent. It lives in the database, so it outlasts the server: a send the
// agent never received, because its wait timed out or it was not
// waiting, is delivered by the next wait or feedback, whichever server
// runs then. An agent never needs a cursor of its own.
const settingDelivered = "delivered"

// seedDelivered starts a database that has no delivery cursor at its
// newest event: what came before counts as delivered, so no old send
// replays as new.
func (s *Server) seedDelivered() error {
	if _, ok, err := s.store.Setting(settingDelivered); err != nil || ok {
		return err
	}
	last, err := s.store.LastEventID()
	if err != nil {
		return err
	}
	return s.store.SetSetting(settingDelivered, strconv.FormatInt(last, 10))
}

func (s *Server) delivered() (int64, error) {
	v, _, err := s.store.Setting(settingDelivered)
	if err != nil {
		return 0, err
	}
	n, _ := strconv.ParseInt(v, 10, 64)
	return n, nil
}

// deliver moves the delivery cursor forward to cursor, never back.
func (s *Server) deliver(cursor int64) error {
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	cur, err := s.delivered()
	if err != nil || cursor <= cur {
		return err
	}
	return s.store.SetSetting(settingDelivered, strconv.FormatInt(cursor, 10))
}

// unsent counts the sends the agent has not received: what the next
// feedback or wait delivers.
func unsent(st *store.Store) (int, error) {
	v, ok, err := st.Setting(settingDelivered)
	if err != nil || !ok {
		return 0, err
	}
	delivered, _ := strconv.ParseInt(v, 10, 64)
	return st.CountEventsSince(delivered, eventSent)
}

// Status is what a status line or a hook asks before anything else:
// whether the reviewer sent something the agent has not received.
type Status struct {
	// Unread counts the sends not yet delivered to the agent.
	Unread int `json:"unread"`
	// Threads counts the open threads of the checked-out branch. Only a
	// running server knows it.
	Threads *int `json:"threads,omitempty"`
}

// handleStatus answers with the status and delivers nothing. It does
// not count as activity either (see secure), so a status line that asks
// every few seconds neither hides a send from the agent nor keeps an
// idle server running.
func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	unread, err := unsent(s.store)
	if err != nil {
		internalError(w, err)
		return
	}
	views, err := s.threadViews(false, false, true)
	if err != nil {
		internalError(w, err)
		return
	}
	threads := len(views)
	writeJSON(w, http.StatusOK, Status{Unread: unread, Threads: &threads})
}

// StoredStatus reads the status of a repository from its database,
// without a server: a send the agent never received outlasts the server
// that took it. A repository revue never served has nothing unread.
func StoredStatus(repoRoot string) (Status, error) {
	dataDir, err := DataDir(repoRoot)
	if err != nil {
		return Status{}, err
	}
	path := filepath.Join(dataDir, "revue.db")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return Status{}, nil
	} else if err != nil {
		return Status{}, err
	}
	st, err := store.OpenReadOnly(path)
	if err != nil {
		return Status{}, err
	}
	defer func() { _ = st.Close() }()
	unread, err := unsent(st)
	return Status{Unread: unread}, err
}

// startCursor is where a feedback or wait reads from: the delivery
// cursor, or the request's since. A since older than what was delivered
// would replay it, and one past every issued cursor was never a cursor,
// such as a thread id; both are refused, and ok is false.
func (s *Server) startCursor(w http.ResponseWriter, r *http.Request) (int64, bool) {
	delivered, err := s.delivered()
	if err != nil {
		internalError(w, err)
		return 0, false
	}
	if !r.URL.Query().Has("since") {
		return delivered, true
	}
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", "since must be a cursor")
		return 0, false
	}
	last, err := s.store.LastEventID()
	if err != nil {
		internalError(w, err)
		return 0, false
	}
	switch {
	case since > last:
		httpError(w, http.StatusBadRequest, "validation",
			fmt.Sprintf("cursor %d was never issued (the latest is %d); leave out --since", since, last))
		return 0, false
	case since < delivered:
		httpError(w, http.StatusBadRequest, "validation",
			fmt.Sprintf("cursor %d is older than the feedback already delivered (cursor %d); leave out --since", since, delivered))
		return 0, false
	}
	return since, true
}
