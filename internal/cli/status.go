package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/rphf/revue/internal/server"
)

// statusView is what `revue status` prints. Threads and URL come from a
// running server; without one they are left out.
type statusView struct {
	Unread  int    `json:"unread"`
	Threads *int   `json:"threads,omitempty"`
	URL     string `json:"url,omitempty"`
	Running bool   `json:"running"`
}

// statusTimeout bounds the question to the server: a status line asks
// every few seconds and must not hang on a server that is going away.
const statusTimeout = 2 * time.Second

// cmdStatus prints whether the reviewer sent something the agent has
// not received. It is made to be asked often and from anywhere: it
// delivers nothing, starts no server, and does not count as activity on
// a running one. Without a server that answers, it reads the
// repository's database, where an undelivered send waits.
func cmdStatus(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("status")
	asJSON := fs.Bool("json", false, "print the status as JSON")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(stderr, "revue:", err)
		return ExitValidation
	}
	repoRoot, err := gitOutput("", "rev-parse", "--show-toplevel")
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "revue must run inside a git repository:", err)
		return ExitValidation
	}

	view, ok := runningStatus(repoRoot)
	if !ok {
		st, err := server.StoredStatus(repoRoot)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "revue:", err)
			return ExitError
		}
		view = statusView{Unread: st.Unread}
	}

	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(view)
		return ExitOK
	}
	_, _ = fmt.Fprintf(stdout, "unread %d\n", view.Unread)
	if view.Threads != nil {
		_, _ = fmt.Fprintf(stdout, "threads %d\n", *view.Threads)
	}
	if view.URL != "" {
		_, _ = fmt.Fprintf(stdout, "url %s\n", view.URL)
	}
	return ExitOK
}

// runningStatus asks the repository's recorded server. Any failure
// reads as no server: none recorded, none listening, or one from a
// build that has no status to give.
func runningStatus(repoRoot string) (statusView, bool) {
	stateDir, err := server.StateDir(repoRoot)
	if err != nil {
		return statusView{}, false
	}
	st, err := server.ReadState(stateDir)
	if err != nil || st.Port == 0 || st.Token == "" {
		return statusView{}, false
	}
	client := &Client{BaseURL: st.BaseURL(), Token: st.Token, HTTP: &http.Client{Timeout: statusTimeout}}
	var status server.Status
	if err := client.do("GET", "/api/status", nil, &status); err != nil || status.Threads == nil {
		return statusView{}, false
	}
	return statusView{Unread: status.Unread, Threads: status.Threads, URL: st.AuthURL("/"), Running: true}, true
}
