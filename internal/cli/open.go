package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rphf/revue/internal/server"
	"github.com/rphf/revue/internal/store"
)

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are reported by callers
	return fs
}

func waitForSignalOr(s *server.Server) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(ctx)
	case <-s.Done():
	}
}

// argsQuery encodes git-diff arguments as the repeated `arg` query
// parameter the server and the page read.
func argsQuery(args []string) string {
	q := url.Values{}
	for _, a := range args {
		q.Add("arg", a)
	}
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}

// pagePath is the page for a diff: the root, with the arguments in the
// query string when there are any.
func pagePath(args []string) string {
	return "/" + argsQuery(args)
}

// cmdOpen opens the browser on a diff. The arguments go through the
// server first, so a bad ref fails here, in the terminal. The printed
// URL carries the one-time token; the server exchanges it for a cookie
// and redirects to a token-free URL.
func (e *env) cmdOpen(args []string) int {
	fs := newFlagSet("open")
	noBrowser := fs.Bool("no-browser", false, "print the URL without launching a browser")
	// The flag package eats a leading bare "--", the marker git needs
	// to read what follows as pathspecs; parse flags only up to it.
	flagArgs, pathArgs := splitAtDoubleDash(args)
	if err := fs.Parse(flagArgs); err != nil {
		_, _ = fmt.Fprintln(e.stderr, err)
		return ExitValidation
	}
	diffArgs := append(append([]string{}, fs.Args()...), pathArgs...)

	var diff struct {
		Files []struct{} `json:"files"`
	}
	if err := e.client.do("GET", "/api/diff"+argsQuery(diffArgs), nil, &diff); err != nil {
		return e.failText(err)
	}
	link := e.state.AuthURL(pagePath(diffArgs))
	_, _ = fmt.Fprintln(e.stdout, link)
	if !*noBrowser {
		if err := e.openURL(link); err != nil {
			_, _ = fmt.Fprintln(e.stderr, "could not open a browser:", err)
		}
	}
	return ExitOK
}

// splitAtDoubleDash separates the arguments before the first bare "--"
// from the "--" itself and everything after it.
func splitAtDoubleDash(args []string) (before, rest []string) {
	for i, a := range args {
		if a == "--" {
			return args[:i], args[i:]
		}
	}
	return args, nil
}

// cmdURL prints a login link for the default diff. A host-side helper
// hands it to a browser; it never fails for lack of changes.
func (e *env) cmdURL(args []string) int {
	fs := newFlagSet("url")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(e.stderr, err)
		return ExitValidation
	}
	_, _ = fmt.Fprintln(e.stdout, e.state.AuthURL("/"))
	return ExitOK
}

// cmdReply posts an agent reply in a thread. The agent can reply but
// never resolve: there is no resolve command.
func (e *env) cmdReply(args []string) int {
	fs := newFlagSet("reply")
	thread := fs.Int64("thread", 0, "thread id (required)")
	message := fs.String("m", "", "reply body (reads stdin when omitted)")
	fs.StringVar(message, "message", *message, "reply body")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	if *thread <= 0 {
		return e.failValidation("--thread is required")
	}
	body := *message
	if body == "" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil || len(data) == 0 {
			return e.failValidation("reply body required: pass -m or pipe stdin")
		}
		body = string(data)
	}
	var out map[string]any
	if err := e.client.do("POST", fmt.Sprintf("/api/threads/%d/comments", *thread), map[string]any{
		"role": store.RoleAgent, "body": body,
	}, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}

// cmdExport prints the server's markdown rendering of the threads.
func (e *env) cmdExport(args []string) int {
	fs := newFlagSet("export")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	md, err := e.client.raw("GET", "/api/export", nil)
	if err != nil {
		return e.fail(err)
	}
	if _, err := e.stdout.Write(md); err != nil {
		return ExitError
	}
	return ExitOK
}
