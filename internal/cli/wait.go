package cli

import (
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// cmdWait blocks until the reviewer sends after the cursor, then prints
// what feedback --since would. A send that lands between invocations is
// delivered by the next one. A timeout prints the cursor to wait from
// and exits 3.
func (e *env) cmdWait(args []string) int {
	fs := newFlagSet("wait")
	since := fs.Int64("since", 0, "cursor from the previous feedback or wait")
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
		Outcome string `json:"outcome"`
		Cursor  int64  `json:"cursor"`
	}
	if err := client.do("GET", path, nil, &out); err != nil {
		return e.fail(err)
	}
	switch out.Outcome {
	case "sent":
		return e.printFeedback(*since)
	case "timeout":
		_, _ = fmt.Fprintf(e.stdout, "cursor %d\ntimeout\n", out.Cursor)
		return ExitWaitTimeout
	default:
		return e.fail(fmt.Errorf("unexpected wait outcome %q", out.Outcome))
	}
}
