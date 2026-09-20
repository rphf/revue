// Package cli is revue's command surface: human commands (open, url,
// serve) and the agent interface (feedback, reply, wait, export) with
// JSON output and a small exit-code contract.
package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/rphf/revue/internal/server"
)

// Exit codes. Stable across releases; documented in docs/cli.md.
const (
	ExitOK          = 0
	ExitError       = 1 // unexpected failure
	ExitValidation  = 2 // bad arguments or invalid request
	ExitWaitTimeout = 3 // wait elapsed without a send
)

// Version is stamped by the release build.
var Version = "dev"

const usage = `revue — local code review on a live diff

Human commands:
  revue [open] [git-diff args]  open the browser on that diff (default: the working tree)
                                --no-browser prints the URL only
  revue url                     print a login link for the default diff
  revue serve                   run the server in the foreground (a container entry point;
                                the other commands start it in the background)

Agent commands (JSON output; exit codes in docs/cli.md):
  feedback [--since C]            unresolved threads with quoted code, plus what happened since C
  reply --thread N -m TEXT        reply in a thread (reads stdin when -m is absent)
  wait [--since C] [--timeout D]  block until the reviewer sends
  export                          threads as markdown

Exit codes: 0 ok, 1 error, 2 bad arguments or invalid request, 3 wait timed out

Environment (read when a server starts; see docs/configuration.md):
  REVUE_BIND, REVUE_PORT, REVUE_PUBLIC_URL, REVUE_IDLE_TIMEOUT, REVUE_DATA_DIR
`

// env carries everything a command needs, so tests can inject a
// client pointed at a test server.
type env struct {
	client    *Client
	publicURL string
	repoRoot  string
	stdout    io.Writer
	stderr    io.Writer
	openURL   func(string) error
}

func (e *env) authURL(next string) string {
	return fmt.Sprintf("%s/auth?token=%s&next=%s", e.publicURL, e.client.Token, url.QueryEscape(next))
}

// Main is the CLI entry point; it returns the process exit code. A
// bare `revue`, or one that starts with a flag or a pathspec
// separator, is `revue open`.
func Main(args []string) int {
	cmd, rest := "open", args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, rest = args[0], args[1:]
	}

	switch cmd {
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(os.Stdout, usage)
		return ExitOK
	case "version", "--version":
		_, _ = fmt.Fprintln(os.Stdout, Version)
		return ExitOK
	case "serve", "__serve":
		return cmdServe(rest)
	}
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		_, _ = fmt.Fprint(os.Stdout, usage)
		return ExitOK
	}

	e, code := connect(os.Stdout, os.Stderr)
	if code != ExitOK {
		return code
	}

	switch cmd {
	case "open":
		return e.cmdOpen(rest)
	case "url":
		return e.cmdURL(rest)
	case "feedback":
		return e.cmdFeedback(rest)
	case "reply":
		return e.cmdReply(rest)
	case "wait":
		return e.cmdWait(rest)
	case "export":
		return e.cmdExport(rest)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		return ExitValidation
	}
}

// connect resolves the repo, ensures a server is running, and builds
// the authenticated client.
func connect(stdout, stderr io.Writer) (*env, int) {
	repoRoot, err := gitOutput("", "rev-parse", "--show-toplevel")
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "revue must run inside a git repository:", err)
		return nil, ExitValidation
	}

	st, err := server.Ensure(repoRoot)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "could not start the revue server:", err)
		return nil, ExitError
	}
	return &env{
		client:    &Client{BaseURL: st.BaseURL(), Token: st.Token, HTTP: &http.Client{}},
		publicURL: st.PublicBaseURL(),
		repoRoot:  repoRoot,
		stdout:    stdout,
		stderr:    stderr,
		openURL:   openInBrowser,
	}, ExitOK
}

func gitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func openInBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// --- HTTP client ---

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// APIError is a non-2xx response with the server's machine-readable
// error code.
type APIError struct {
	Status  int    `json:"-"`
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *APIError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

func (c *Client) newRequest(method, path string) (*http.Request, error) {
	req, err := http.NewRequest(method, c.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	return req, nil
}

func (c *Client) do(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		apiErr := &APIError{Status: resp.StatusCode, Code: "unknown", Message: string(data)}
		_ = json.Unmarshal(data, apiErr)
		return apiErr
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// --- output and error mapping ---

// printJSON writes indented JSON to stdout: the machine-readable
// surface.
func (e *env) printJSON(v any) int {
	enc := json.NewEncoder(e.stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		_, _ = fmt.Fprintln(e.stderr, err)
		return ExitError
	}
	return ExitOK
}

// exitCodeFor maps a server error to the exit-code contract: anything
// the caller could have asked differently is a validation failure.
func exitCodeFor(err error) int {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Code {
		case "validation", "not_found", "stale_diff", "not_draft", "unsupported_type":
			return ExitValidation
		}
	}
	return ExitError
}

// fail prints a machine-readable error object and returns the mapped
// exit code. Errors go to stdout: they are part of the agent contract,
// not diagnostics.
func (e *env) fail(err error) int {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		e.printJSON(apiErr)
	} else {
		e.printJSON(&APIError{Code: "error", Message: err.Error()})
	}
	return exitCodeFor(err)
}

func (e *env) failValidation(msg string) int {
	e.printJSON(&APIError{Code: "validation", Message: msg})
	return ExitValidation
}

// failText is fail for the human commands: one line on stderr.
func (e *env) failText(err error) int {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		_, _ = fmt.Fprintln(e.stderr, apiErr.Message)
	} else {
		_, _ = fmt.Fprintln(e.stderr, err.Error())
	}
	return exitCodeFor(err)
}

// --- serve ---

func cmdServe(args []string) int {
	fs := newFlagSet("serve")
	repo := fs.String("repo", "", "repository to serve (default: enclosing repo)")
	idle := fs.Duration("idle-timeout", defaultIdleTimeout(), "shut down after this quiet period (0 disables)")
	bind := fs.String("bind", os.Getenv("REVUE_BIND"), "listen address (default 127.0.0.1; $REVUE_BIND)")
	port := fs.Int("port", envInt("REVUE_PORT"), "fixed listen port (default: recorded or ephemeral; $REVUE_PORT)")
	publicURL := fs.String("public-url", os.Getenv("REVUE_PUBLIC_URL"), "browser-facing base URL ($REVUE_PUBLIC_URL)")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitValidation
	}
	repoRoot := *repo
	if repoRoot == "" {
		var err error
		repoRoot, err = gitOutput("", "rev-parse", "--show-toplevel")
		if err != nil {
			fmt.Fprintln(os.Stderr, "not inside a git repository and no --repo given")
			return ExitValidation
		}
	}
	s, err := server.Start(server.Config{
		RepoRoot:    repoRoot,
		IdleTimeout: *idle,
		Bind:        *bind,
		Port:        *port,
		PublicURL:   *publicURL,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitError
	}
	fmt.Printf("revue serving %s on %s (browser: %s)\n", repoRoot, s.URL(), s.PublicURL())
	waitForSignalOr(s)
	return ExitOK
}

func defaultIdleTimeout() time.Duration {
	if v := os.Getenv("REVUE_IDLE_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return 30 * time.Minute
}

func envInt(name string) int {
	v := os.Getenv(name)
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ignoring %s=%q: not an integer\n", name, v)
		return 0
	}
	return n
}
