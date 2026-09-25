package cli

import (
	"encoding/json"
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
	Threads  []feedbackThread `json:"threads"`
	LastSend *struct {
		Note string `json:"note"`
	} `json:"lastSend"`
	Landed []int64 `json:"landed"`
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

// cmdFeedback prints what the agent has to act on. Without --since:
// every unresolved thread and the last send's note. With it: only what
// the reviewer did after cursor C.
func (e *env) cmdFeedback(args []string) int {
	fs := newFlagSet("feedback")
	since := fs.Int64("since", 0, "cursor from the previous feedback or wait")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	return e.printFeedback(*since)
}

func (e *env) printFeedback(since int64) int {
	var fb feedbackData
	if err := e.client.do("GET", fmt.Sprintf("/api/feedback?since=%d", since), nil, &fb); err != nil {
		return e.fail(err)
	}
	renderFeedback(e.stdout, &fb, since)
	return ExitOK
}

// renderFeedback writes the feedback as text: a cursor line, the note,
// one block per thread, then the resolved and landed ids. Anything at
// column 0 starts an item; a body's further lines are indented.
func renderFeedback(w io.Writer, fb *feedbackData, since int64) {
	note := ""
	touched := map[int64]bool{}
	var resolved []int64
	if since == 0 {
		if fb.LastSend != nil {
			note = fb.LastSend.Note
		}
	} else {
		for _, ev := range fb.Events {
			switch ev.Type {
			case "sent":
				var p struct {
					Send struct {
						Note string `json:"note"`
					} `json:"send"`
					Threads []struct {
						ID int64 `json:"id"`
					} `json:"threads"`
				}
				_ = json.Unmarshal(ev.Payload, &p)
				note = p.Send.Note
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
	}

	_, _ = fmt.Fprintf(w, "cursor %d\n", fb.Cursor)
	if strings.TrimSpace(note) != "" {
		writeField(w, "note", note)
	}
	for _, t := range fb.Threads {
		if since != 0 && !touched[t.ID] {
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
