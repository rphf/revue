package cli

import (
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// cmdWait blocks until the reviewer sends something not yet delivered,
// then prints it as feedback --since would from where the wait started.
// A send that lands between invocations is delivered by the next one.
// --since C waits from cursor C instead. A timeout prints the cursor
// and exits 3.
func (e *env) cmdWait(args []string) int {
	fs := newFlagSet("wait")
	since := fs.Int64("since", 0, "wait from this cursor instead of what was delivered")
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

	q := url.Values{"timeout": {timeout.String()}}
	if isSet(fs, "since") {
		q.Set("since", fmt.Sprint(*since))
	}
	var out struct {
		Outcome string `json:"outcome"`
		Since   int64  `json:"since"`
		Cursor  int64  `json:"cursor"`
	}
	if err := client.do("GET", "/api/wait?"+q.Encode(), nil, &out); err != nil {
		return e.fail(err)
	}
	switch out.Outcome {
	case "sent":
		return e.printFeedback(&out.Since)
	case "timeout":
		_, _ = fmt.Fprintf(e.stdout, "cursor %d\ntimeout\n", out.Cursor)
		return ExitWaitTimeout
	default:
		return e.fail(fmt.Errorf("unexpected wait outcome %q", out.Outcome))
	}
}
