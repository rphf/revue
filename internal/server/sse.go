package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/rphf/revue/internal/store"
)

// bus wakes subscribers when the event log grows. Subscribers then
// re-query the persistent log from their cursor, so nothing can be
// missed between replay and subscribe.
type bus struct {
	mu   sync.Mutex
	subs map[chan struct{}]bool
}

func newBus() *bus {
	return &bus{subs: map[chan struct{}]bool{}}
}

func (b *bus) subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	b.subs[ch] = true
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}
}

// notify wakes every subscriber and reports how many there are.
func (b *bus) notify() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- struct{}{}:
		default: // already pending; subscriber will re-query anyway
		}
	}
	return len(b.subs)
}

// diffPollInterval is how often an open event stream checks whether
// its diff moved.
const diffPollInterval = time.Second

// handleEvents streams the event log over SSE, replaying from ?since=
// (or, on an EventSource reconnect, the Last-Event-ID header) first, and tells the page when the diff for its `arg` parameters
// changed. Open streams block idle shutdown.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpError(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}
	v, err := s.views.get(queryArgs(r))
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	since := r.URL.Query().Get("since")
	if since == "" {
		since = r.Header.Get("Last-Event-ID")
	}

	s.activity.connOpen()
	defer s.activity.connClose()

	wake, cancel := s.bus.subscribe()
	defer cancel()
	focus, stopFocus := v.pages.subscribe()
	defer stopFocus()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// The first notice carries the current version, so a page that
	// connected after the diff moved refetches without waiting a tick.
	if c, err := v.load(s.repoRoot); err == nil && c != nil {
		if err := writeDiffChanged(w, c.version); err != nil {
			return
		}
	}

	cursor := parseInt64(since)
	poll := time.NewTicker(diffPollInterval)
	defer poll.Stop()
	// Keep-alive comments let proxies and clients detect dead streams.
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	// The log only grows on a bus wake, so it is re-read then and on
	// the first pass, not on poll or keep-alive ticks.
	pending := true
	for {
		if pending {
			pending = false
			events, err := s.store.EventsSince(cursor)
			if err != nil {
				return
			}
			for _, e := range events {
				data, err := json.Marshal(e)
				if err != nil {
					return
				}
				// No `event:` field: named SSE events bypass
				// EventSource.onmessage, and the type is already in the
				// JSON payload.
				if _, err := fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, data); err != nil {
					return
				}
				cursor = e.ID
			}
			flusher.Flush()
		}

		select {
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		case <-wake:
			pending = true
		case <-poll.C:
			changed, err := v.refresh(s.repoRoot, false)
			if err != nil || !changed {
				continue
			}
			if c := v.current(); c != nil {
				if err := writeDiffChanged(w, c.version); err != nil {
					return
				}
				flusher.Flush()
			}
		case <-focus:
			if err := writeNotice(w, eventFocus, nil); err != nil {
				return
			}
			flusher.Flush()
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeDiffChanged(w io.Writer, version int64) error {
	return writeNotice(w, eventDiffChanged, map[string]any{"version": version})
}

// writeNotice writes a frame that is not in the event log: it has no
// id, so a reconnect neither replays it nor resumes from it.
func writeNotice(w io.Writer, typ string, payload any) error {
	data, err := json.Marshal(map[string]any{"type": typ, "payload": payload})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	return err
}

// handleFocus asks the pages open on a diff to bring themselves to the
// user's attention, and reports how many there are. `revue open` opens
// a new tab only when there are none.
func (s *Server) handleFocus(w http.ResponseWriter, r *http.Request) {
	v, err := s.views.get(queryArgs(r))
	if err != nil {
		httpError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"pages": v.pages.notify()})
}

// waitOutcome is the long-poll result for the CLI's `revue wait`.
type waitOutcome struct {
	Outcome string      `json:"outcome"` // sent | timeout
	Cursor  int64       `json:"cursor"`
	Send    *store.Send `json:"send,omitempty"`
}

// handleWait long-polls the event log until a send lands after the
// cursor. Because the log is persistent, a send that landed while no
// wait was active is delivered by the next call.
func (s *Server) handleWait(w http.ResponseWriter, r *http.Request) {
	since := parseInt64(r.URL.Query().Get("since"))
	timeout := 30 * time.Second
	if t := r.URL.Query().Get("timeout"); t != "" {
		d, err := time.ParseDuration(t)
		if err != nil || d <= 0 {
			httpError(w, http.StatusBadRequest, "validation", "invalid timeout")
			return
		}
		timeout = d
	}

	s.activity.connOpen()
	defer s.activity.connClose()

	wake, cancel := s.bus.subscribe()
	defer cancel()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	cursor := since
	for {
		events, err := s.store.EventsSince(cursor)
		if err != nil {
			internalError(w, err)
			return
		}
		for _, e := range events {
			cursor = e.ID
			if e.Type != eventSent {
				continue
			}
			var payload struct {
				Send *store.Send `json:"send"`
			}
			_ = json.Unmarshal(e.Payload, &payload)
			writeJSON(w, http.StatusOK, waitOutcome{Outcome: "sent", Cursor: cursor, Send: payload.Send})
			return
		}

		select {
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		case <-deadline.C:
			writeJSON(w, http.StatusOK, waitOutcome{Outcome: "timeout", Cursor: cursor})
			return
		case <-wake:
		}
	}
}
