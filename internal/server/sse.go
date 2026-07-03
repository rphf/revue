package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/rphf/revue/internal/store"
)

// bus wakes subscribers when a review gains events. Subscribers then
// re-query the persistent log from their cursor, so nothing can be
// missed between replay and subscribe (KTD6).
type bus struct {
	mu   sync.Mutex
	subs map[int64]map[chan struct{}]bool
}

func newBus() *bus {
	return &bus{subs: map[int64]map[chan struct{}]bool{}}
}

func (b *bus) subscribe(reviewID int64) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	if b.subs[reviewID] == nil {
		b.subs[reviewID] = map[chan struct{}]bool{}
	}
	b.subs[reviewID][ch] = true
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs[reviewID], ch)
		b.mu.Unlock()
	}
}

func (b *bus) notify(reviewID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs[reviewID] {
		select {
		case ch <- struct{}{}:
		default: // already pending; subscriber will re-query anyway
		}
	}
}

// handleEvents streams a review's event log over SSE: replay from
// ?since= first, then live (R7). Open streams block idle shutdown.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpError(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}
	since := parseInt64(r.URL.Query().Get("since"))

	s.activity.connOpen()
	defer s.activity.connClose()

	wake, cancel := s.bus.subscribe(review.ID)
	defer cancel()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	cursor := since
	// Keep-alive comments let proxies and clients detect dead streams.
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		events, err := s.store.EventsSince(review.ID, cursor)
		if err != nil {
			return
		}
		for _, e := range events {
			data, err := json.Marshal(e)
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.ID, e.Type, data); err != nil {
				return
			}
			cursor = e.ID
		}
		flusher.Flush()

		select {
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		case <-wake:
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// waitOutcome is the long-poll result for the CLI's `revue wait`.
type waitOutcome struct {
	Outcome    string            `json:"outcome"` // submitted | closed | timeout
	Cursor     int64             `json:"cursor"`
	Review     *store.Review     `json:"review"`
	Submission *store.Submission `json:"submission,omitempty"`
}

// handleWait long-polls the event log until a submission or close
// lands after the cursor (KTD6). Because the log is persistent, a
// submission that landed while no wait was active is delivered by the
// next call (AE6).
func (s *Server) handleWait(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
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

	wake, cancel := s.bus.subscribe(review.ID)
	defer cancel()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	cursor := since
	for {
		events, err := s.store.EventsSince(review.ID, cursor)
		if err != nil {
			httpError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		for _, e := range events {
			cursor = e.ID
			switch e.Type {
			case eventSubmitted:
				var payload struct {
					Submission *store.Submission `json:"submission"`
				}
				json.Unmarshal(e.Payload, &payload)
				current, _ := s.store.GetReview(review.ID)
				writeJSON(w, http.StatusOK, waitOutcome{
					Outcome: "submitted", Cursor: cursor, Review: current, Submission: payload.Submission,
				})
				return
			case eventClosed:
				current, _ := s.store.GetReview(review.ID)
				writeJSON(w, http.StatusOK, waitOutcome{Outcome: "closed", Cursor: cursor, Review: current})
				return
			}
		}

		select {
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		case <-deadline.C:
			current, _ := s.store.GetReview(review.ID)
			writeJSON(w, http.StatusOK, waitOutcome{Outcome: "timeout", Cursor: cursor, Review: current})
			return
		case <-wake:
		}
	}
}
