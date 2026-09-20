package cli

import (
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// cmdWait blocks until the reviewer sends after the cursor. It is a
// resumable convenience over the same event log the cursor reads use:
// a send that lands between invocations is delivered by the next one.
// Exit codes are distinct for a send (0) and a timeout (3).
func (e *env) cmdWait(args []string) int {
	fs := newFlagSet("wait")
	since := fs.Int64("since", 0, "cursor: only consider events after this id")
	timeout := fs.Duration("timeout", 5*time.Minute, "give up after this duration")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	if *timeout <= 0 {
		return e.failValidation("--timeout must be positive")
	}

	// The long-poll must outlive the client's default timeout.
	client := *e.client
	client.HTTP = &http.Client{Timeout: *timeout + 30*time.Second}

	path := fmt.Sprintf("/api/wait?since=%d&timeout=%s", *since, url.QueryEscape(timeout.String()))
	var out struct {
		Outcome string         `json:"outcome"`
		Cursor  int64          `json:"cursor"`
		Send    map[string]any `json:"send,omitempty"`
	}
	if err := client.do("GET", path, nil, &out); err != nil {
		return e.fail(err)
	}
	if code := e.printJSON(out); code != ExitOK {
		return code
	}
	switch out.Outcome {
	case "sent":
		return ExitOK
	case "timeout":
		return ExitWaitTimeout
	default:
		return ExitError
	}
}
