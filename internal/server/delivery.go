package server

import (
	"fmt"
	"net/http"
	"strconv"
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
