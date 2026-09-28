package server

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/rphf/revue/internal/gitx"
	"github.com/rphf/revue/internal/store"
)

// eventNoteChanged tells the page the branch's agent note was written
// or cleared.
const eventNoteChanged = "note.changed"

// noteView is the agent note as the page shows it. Outdated means the
// working tree changed after the note was written, so it describes
// older code.
type noteView struct {
	Body      string    `json:"body"`
	UpdatedAt time.Time `json:"updatedAt"`
	Outdated  bool      `json:"outdated"`
}

// currentNote is the checked-out branch's agent note while its round
// lasts: once HEAD moves past the commit it was written on, the work it
// describes is committed, and the note is done; so is a note from
// before revue recorded the commit. nil without one.
func (s *Server) currentNote() (*store.Note, error) {
	commit, branch := s.head()
	n, err := s.store.GetNote(branch)
	if err != nil || n == nil {
		return nil, err
	}
	if n.Head != commit {
		return nil, nil
	}
	return n, nil
}

// handleGetNote returns the checked-out branch's agent note, or null.
func (s *Server) handleGetNote(w http.ResponseWriter, _ *http.Request) {
	n, err := s.currentNote()
	if err != nil {
		internalError(w, err)
		return
	}
	if n == nil {
		writeJSON(w, http.StatusOK, map[string]any{"note": nil})
		return
	}
	v := noteView{Body: n.Body, UpdatedAt: n.UpdatedAt}
	if n.Tree != "" {
		tree, err := gitx.WorkingTree(s.repoRoot)
		if err != nil {
			internalError(w, err)
			return
		}
		v.Outdated = tree != n.Tree
	}
	writeJSON(w, http.StatusOK, map[string]any{"note": v})
}

type noteRequest struct {
	Body string `json:"body"`
}

// handlePutNote replaces the checked-out branch's agent note, recording
// the working tree it describes.
func (s *Server) handlePutNote(w http.ResponseWriter, r *http.Request) {
	var req noteRequest
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		httpError(w, http.StatusBadRequest, "validation", "the note is empty; clear it instead")
		return
	}
	// Without a tree the note stands, and is then never outdated.
	tree, err := gitx.WorkingTree(s.repoRoot)
	if err != nil {
		log.Printf("revue: working tree at a note: %v", err)
	}
	commit, branch := s.head()
	var n *store.Note
	err = s.store.WithTx(func(tx *store.Store) error {
		var err error
		if n, err = tx.SetNote(branch, req.Body, tree, commit); err != nil {
			return err
		}
		_, err = tx.AppendEvent(eventNoteChanged, map[string]any{"branch": branch})
		return err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	s.bus.notify()
	writeJSON(w, http.StatusOK, map[string]any{"note": noteView{Body: n.Body, UpdatedAt: n.UpdatedAt}})
}

// handleDeleteNote clears the checked-out branch's agent note.
func (s *Server) handleDeleteNote(w http.ResponseWriter, _ *http.Request) {
	_, branch := s.head()
	err := s.store.WithTx(func(tx *store.Store) error {
		had, err := tx.DeleteNote(branch)
		if err != nil || !had {
			return err
		}
		_, err = tx.AppendEvent(eventNoteChanged, map[string]any{"branch": branch})
		return err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	s.bus.notify()
	w.WriteHeader(http.StatusNoContent)
}
