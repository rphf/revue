package cli

import (
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// cmdWait blocks until a submission or close lands after the cursor
// (R11). It is a resumable convenience over the same event log the
// cursor reads use: a submission that lands between invocations is
// delivered by the next one (AE6). Exit codes are distinct for
// submission (0), timeout (4), and close (5).
func (e *env) cmdWait(args []string) int {
	fs := newFlagSet("wait")
	review := fs.Int64("review", 0, "review id (default: single open review for this branch)")
	since := fs.Int64("since", 0, "cursor: only consider events after this id")
	timeout := fs.Duration("timeout", 5*time.Minute, "give up after this duration")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	if *timeout <= 0 {
		return e.failValidation("--timeout must be positive")
	}
	id, code := e.resolveReview(*review)
	if code != ExitOK {
		return code
	}

	// The long-poll must outlive the client's default timeout.
	client := *e.client
	client.HTTP = &http.Client{Timeout: *timeout + 30*time.Second}

	path := fmt.Sprintf("/api/reviews/%d/wait?since=%d&timeout=%s", id, *since, url.QueryEscape(timeout.String()))
	var out struct {
		Outcome    string         `json:"outcome"`
		Cursor     int64          `json:"cursor"`
		Review     map[string]any `json:"review"`
		Submission map[string]any `json:"submission,omitempty"`
	}
	if err := client.do("GET", path, nil, &out); err != nil {
		return e.fail(err)
	}
	code = e.printJSON(out)
	if code != ExitOK {
		return code
	}
	switch out.Outcome {
	case "submitted":
		return ExitOK
	case "timeout":
		return ExitWaitTimeout
	case "closed":
		return ExitClosed
	default:
		return ExitError
	}
}
