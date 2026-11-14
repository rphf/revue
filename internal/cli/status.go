package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/rphf/revue/internal/server"
)

// statusView is the status of one repository. Threads and URL come from
// a running server; without one they are left out. Repo is set when the
// status is one of a session's.
type statusView struct {
	Repo    string `json:"repo,omitempty"`
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
//
// With --session it prints the status of every repository that session
// ran revue in, wherever the command runs: an agent reviews where its
// change is, which is not always its working directory.
func cmdStatus(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("status")
	asJSON := fs.Bool("json", false, "print the status as JSON")
	session := fs.String("session", "", "the repositories this session ran revue in")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(stderr, "revue:", err)
		return ExitValidation
	}
	if isSet(fs, "session") {
		return sessionStatus(*session, *asJSON, stdout, stderr)
	}
	repoRoot, err := gitOutput("", "rev-parse", "--show-toplevel")
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "revue must run inside a git repository:", err)
		return ExitValidation
	}
	view, err := statusOf(repoRoot)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "revue:", err)
		return ExitError
	}
	if *asJSON {
		writeJSONLine(stdout, view)
		return ExitOK
	}
	writeStatus(stdout, view)
	return ExitOK
}

// sessionStatus prints the status of each repository of the session. A
// session revue never saw has none, which is not an error; a repository
// that is gone from disk is left out.
func sessionStatus(id string, asJSON bool, stdout, stderr io.Writer) int {
	if id == "" {
		_, _ = fmt.Fprintln(stderr, "revue: --session needs an id")
		return ExitValidation
	}
	repos, err := server.SessionRepos(id)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "revue:", err)
		return ExitError
	}
	views := []statusView{}
	for _, repo := range repos {
		if _, err := os.Stat(repo); err != nil {
			continue
		}
		view, err := statusOf(repo)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "revue:", err)
			return ExitError
		}
		view.Repo = repo
		views = append(views, view)
	}
	if asJSON {
		writeJSONLine(stdout, map[string]any{"repos": views})
		return ExitOK
	}
	for _, view := range views {
		_, _ = fmt.Fprintf(stdout, "repo %s\n", view.Repo)
		writeStatus(stdout, view)
	}
	return ExitOK
}

func writeJSONLine(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeStatus(w io.Writer, view statusView) {
	_, _ = fmt.Fprintf(w, "unread %d\n", view.Unread)
	if view.Threads != nil {
		_, _ = fmt.Fprintf(w, "threads %d\n", *view.Threads)
	}
	if view.URL != "" {
		_, _ = fmt.Fprintf(w, "url %s\n", view.URL)
	}
}

// statusOf asks the repository's running server, or reads its database.
func statusOf(repoRoot string) (statusView, error) {
	if view, ok := runningStatus(repoRoot); ok {
		return view, nil
	}
	st, err := server.StoredStatus(repoRoot)
	return statusView{Unread: st.Unread}, err
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
