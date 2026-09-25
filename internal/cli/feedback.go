package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
)

// feedbackData is the part of the server's feedback the agent acts on.
type feedbackData struct {
	Cursor int64 `json:"cursor"`
	Events []struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	} `json:"events"`
	Threads []feedbackThread `json:"threads"`
	Stale   []int64          `json:"stale"`
	Landed  []int64          `json:"landed"`
}

type feedbackThread struct {
	ID        int64  `json:"id"`
	Path      string `json:"path"`
	Side      string `json:"side"`
	StartLine *int   `json:"startLine"`
	Line      int    `json:"line"`
	Outdated  bool   `json:"outdated"`
	Quote     *struct {
		Lines []string `json:"lines"`
	} `json:"quote"`
	Comments []struct {
		AuthorRole string `json:"authorRole"`
		Body       string `json:"body"`
	} `json:"comments"`
}

// cmdFeedback prints what the agent has to act on: every unresolved
// thread and the notes of the sends not yet delivered. With --since C:
// only what the reviewer did after cursor C.
func (e *env) cmdFeedback(args []string) int {
	fs := newFlagSet("feedback")
	since := fs.Int64("since", 0, "only what came after this cursor")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	if !isSet(fs, "since") {
		return e.printFeedback(nil)
	}
	return e.printFeedback(since)
}

// isSet reports whether the flag was given, as opposed to defaulted.
func isSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) { set = set || f.Name == name })
	return set
}

// printFeedback prints the feedback from the delivery cursor, or with
// since, only what came after it.
func (e *env) printFeedback(since *int64) int {
	path := "/api/feedback"
	if since != nil {
		path += fmt.Sprintf("?since=%d", *since)
	}
	var fb feedbackData
	if err := e.client.do("GET", path, nil, &fb); err != nil {
		return e.fail(err)
	}
	renderFeedback(e.stdout, &fb, since != nil)
	return ExitOK
}

// sentNote is a send's note, and whether the code changed after it.
type sentNote struct {
	text  string
	stale bool
}

// renderFeedback writes the feedback as text: a cursor line, the notes,
// one block per thread, then the resolved and landed ids. Anything at
// column 0 starts an item; a body's further lines are indented.
// Incremental output lists only the threads the events touched.
func renderFeedback(w io.Writer, fb *feedbackData, incremental bool) {
	var notes []sentNote
	touched := map[int64]bool{}
	var resolved []int64
	for _, ev := range fb.Events {
		switch ev.Type {
		case "sent":
			var p struct {
				Send struct {
					ID   int64  `json:"id"`
					Note string `json:"note"`
				} `json:"send"`
				Threads []struct {
					ID int64 `json:"id"`
				} `json:"threads"`
			}
			_ = json.Unmarshal(ev.Payload, &p)
			if strings.TrimSpace(p.Send.Note) != "" {
				notes = append(notes, sentNote{p.Send.Note, slices.Contains(fb.Stale, p.Send.ID)})
			}
			for _, t := range p.Threads {
				touched[t.ID] = true
			}
		case "thread.resolved", "thread.unresolved":
			var p struct {
				ThreadID int64 `json:"threadId"`
			}
			_ = json.Unmarshal(ev.Payload, &p)
			resolved = slices.DeleteFunc(resolved, func(id int64) bool { return id == p.ThreadID })
			if ev.Type == "thread.resolved" {
				resolved = append(resolved, p.ThreadID)
			} else {
				touched[p.ThreadID] = true
			}
		}
	}

	_, _ = fmt.Fprintf(w, "cursor %d\n", fb.Cursor)
	for _, n := range notes {
		writeField(w, "note", n.text)
		if n.stale {
			_, _ = fmt.Fprintln(w, "stale: the code changed after this send; its note does not approve the current diff")
		}
	}
	for _, t := range fb.Threads {
		if incremental && !touched[t.ID] {
			continue
		}
		_, _ = fmt.Fprintf(w, "\n%s\n", threadHeader(&t))
		if t.Quote != nil {
			for _, l := range t.Quote.Lines {
				_, _ = fmt.Fprintf(w, "  | %s\n", l)
			}
		}
		for _, c := range t.Comments {
			writeField(w, c.AuthorRole, c.Body)
		}
	}
	if len(resolved) > 0 || len(fb.Landed) > 0 {
		_, _ = fmt.Fprintln(w)
	}
	writeIDs(w, "resolved", resolved)
	writeIDs(w, "landed", fb.Landed)
}

// threadHeader is "#ID PATH[:LINE[-END]]", then "old" for a line of the
// old side and "outdated" when that code is gone from the diff.
func threadHeader(t *feedbackThread) string {
	at := t.Path
	if t.Line > 0 {
		at += ":" + strconv.Itoa(t.Line)
		if t.StartLine != nil && *t.StartLine != t.Line {
			at = fmt.Sprintf("%s:%d-%d", t.Path, *t.StartLine, t.Line)
		}
	}
	h := fmt.Sprintf("#%d %s", t.ID, at)
	if t.Side == "deletions" && t.Line > 0 {
		h += " old"
	}
	if t.Outdated {
		h += " outdated"
	}
	return h
}

// writeField writes "key: text" with the text's further lines indented.
func writeField(w io.Writer, key, text string) {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	_, _ = fmt.Fprintf(w, "%s: %s\n", key, lines[0])
	for _, l := range lines[1:] {
		_, _ = fmt.Fprintf(w, "  %s\n", l)
	}
}

func writeIDs(w io.Writer, key string, ids []int64) {
	if len(ids) == 0 {
		return
	}
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = strconv.FormatInt(id, 10)
	}
	_, _ = fmt.Fprintf(w, "%s: %s\n", key, strings.Join(s, " "))
}
