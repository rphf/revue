package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"text/tabwriter"

	"github.com/rphf/revue/internal/server"
)

type serverView struct {
	Repo string `json:"repo"`
	Port int    `json:"port"`
	PID  int    `json:"pid"`
	URL  string `json:"url"`
}

func viewOf(st *server.State) serverView {
	repo := st.Repo
	if repo == "" {
		// Servers started by an older build did not record their repo.
		repo = "(unknown)"
	}
	url := st.PublicURL
	if url == "" {
		url = st.BaseURL()
	}
	return serverView{Repo: repo, Port: st.Port, PID: st.PID, URL: url}
}

// cmdServers lists the revue servers running for this user, one per
// repository, without starting any.
func cmdServers(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("servers")
	asJSON := fs.Bool("json", false, "print the list as JSON")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return ExitValidation
	}
	running, err := server.Running()
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return ExitError
	}
	views := make([]serverView, 0, len(running))
	for _, st := range running {
		views = append(views, viewOf(st))
	}
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(map[string]any{"servers": views})
		return ExitOK
	}
	if len(views) == 0 {
		_, _ = fmt.Fprintln(stdout, "no revue server is running")
		return ExitOK
	}
	w := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(w, "REPO\tPORT\tPID\tURL")
	for _, v := range views {
		_, _ = fmt.Fprintf(w, "%s\t%d\t%d\t%s\n", v.Repo, v.Port, v.PID, v.URL)
	}
	_ = w.Flush()
	return ExitOK
}

// cmdStop stops this repository's server, or with --all every running
// one. Stopping nothing is not an error. It never starts a server.
func cmdStop(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("stop")
	all := fs.Bool("all", false, "stop every running revue server")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return ExitValidation
	}
	var targets []*server.State
	if *all {
		running, err := server.Running()
		if err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			return ExitError
		}
		targets = running
	} else {
		repoRoot, err := gitOutput("", "rev-parse", "--show-toplevel")
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "revue stop must run inside a git repository, or pass --all:", err)
			return ExitValidation
		}
		stateDir, err := server.StateDir(repoRoot)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			return ExitError
		}
		st, err := server.ReadState(stateDir)
		if err != nil || !server.Healthy(st) {
			_, _ = fmt.Fprintln(stdout, "no revue server is running for", repoRoot)
			return ExitOK
		}
		if st.Repo == "" {
			st.Repo = repoRoot
		}
		targets = []*server.State{st}
	}
	if len(targets) == 0 {
		_, _ = fmt.Fprintln(stdout, "no revue server is running")
		return ExitOK
	}
	code := ExitOK
	for _, st := range targets {
		v := viewOf(st)
		if err := server.Stop(st); err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			code = ExitError
			continue
		}
		_, _ = fmt.Fprintf(stdout, "stopped %s (port %d, pid %d)\n", v.Repo, v.Port, v.PID)
	}
	return code
}
