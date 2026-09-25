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

const usage = `revue: code review on a live git diff. The reviewer comments in a
browser and sends; the agent reads and answers here.

Agent:
  feedback [--since C]     what to act on; with C, only what came after it
  wait [--since C] [--timeout 5m]
                           block until the reviewer sends, then print as
                           feedback --since C; exit 3 on timeout
  reply ID [TEXT]          answer thread ID (TEXT from stdin when absent)
  comment PATH[:LINE[-END]] [TEXT] [--old] [-- GIT-DIFF-ARGS]
                           open a thread, e.g. to explain a change before
                           review; prints its ID. No LINE: the whole file.
                           --old: LINE is in the old file. Default diff:
                           the working tree
  archive ID... | --landed | --resolved | --all
  unarchive ID
  export                   every thread as markdown

feedback and wait print:
  cursor C                 pass it as --since next time
  note: TEXT               the reviewer's note with the send
  #ID PATH:LINE[-END] [old] [outdated]
    | the code as it was when commented
  reviewer: TEXT           comments in order; lines after the first of a
  agent: TEXT              text are indented by two spaces
  resolved: ID...          resolved by the reviewer; nothing to do
  landed: ID...            code committed; archive --landed when asked
outdated: the code changed since the comment. The reviewer resolves
threads; an agent cannot.

Human:
  [open] [GIT-DIFF-ARGS] [--no-browser]
                           show a diff in the browser; prints the login URL
  url                      print a login URL for the working tree
  serve                    run the server in the foreground (containers)
  servers [--json] | stop [--all] | update [--check] [--force]
  prune [--dry-run] | version

Exit: 0 ok, 1 error, 2 bad request, 3 wait timed out. Errors: one line on
stderr. Env, read at server start: REVUE_BIND REVUE_PORT REVUE_PUBLIC_URL
REVUE_IDLE_TIMEOUT REVUE_DATA_DIR REVUE_ARCHIVE_RETENTION.
`

// env carries everything a command needs, so tests can inject a
// client pointed at a test server.
type env struct {
	client   *Client
	state    *server.State
	repoRoot string
	stdout   io.Writer
	stderr   io.Writer
	openURL  func(string) error
}

// Main is the CLI entry point; it returns the process exit code. A
// bare `revue`, or one that starts with a flag or a pathspec
// separator, is `revue open`.
func Main(args []string) int {
	// Help and version come first: they must work outside a repository,
	// and their flag forms would otherwise read as `revue open`.
	if len(args) > 0 {
		switch args[0] {
		case "help", "-h", "--help":
			_, _ = fmt.Fprint(os.Stdout, usage)
			return ExitOK
		case "version", "--version":
			_, _ = fmt.Fprintln(os.Stdout, Version)
			return ExitOK
		}
	}
	cmd, rest := "open", args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, rest = args[0], args[1:]
	}
	if len(rest) > 0 && (rest[0] == "-h" || rest[0] == "--help") {
		_, _ = fmt.Fprint(os.Stdout, usage)
		return ExitOK
	}

	switch cmd {
	case "serve", "__serve":
		return cmdServe(rest)
	case "servers":
		return cmdServers(rest, os.Stdout, os.Stderr)
	case "stop":
		return cmdStop(rest, os.Stdout, os.Stderr)
	case "update":
		return cmdUpdate(rest, os.Stdout, os.Stderr)
	case "prune":
		return cmdPrune(rest, os.Stdout, os.Stderr)
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
	case "comment":
		return e.cmdComment(rest)
	case "reply":
		return e.cmdReply(rest)
	case "wait":
		return e.cmdWait(rest)
	case "export":
		return e.cmdExport(rest)
	case "archive":
		return e.cmdArchive(rest)
	case "unarchive":
		return e.cmdUnarchive(rest)
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
		client:   &Client{BaseURL: st.BaseURL(), Token: st.Token, HTTP: &http.Client{}},
		state:    st,
		repoRoot: repoRoot,
		stdout:   stdout,
		stderr:   stderr,
		openURL:  openInBrowser,
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

// raw sends an authenticated request, with body as JSON when set, and
// returns the response body. A 4xx or 5xx answer is an *APIError.
func (c *Client) raw(method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		apiErr := &APIError{Status: resp.StatusCode, Code: "unknown", Message: string(data)}
		_ = json.Unmarshal(data, apiErr)
		return nil, apiErr
	}
	return data, nil
}

// do is raw with the JSON response decoded into out, when set.
func (c *Client) do(method, path string, body any, out any) error {
	data, err := c.raw(method, path, body)
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// --- output and error mapping ---

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

// fail prints the error as one line on stderr and returns the mapped
// exit code, which tells the agent what kind of failure it was.
func (e *env) fail(err error) int {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		_, _ = fmt.Fprintln(e.stderr, "revue:", apiErr.Message)
	} else {
		_, _ = fmt.Fprintln(e.stderr, "revue:", err)
	}
	return exitCodeFor(err)
}

func (e *env) failValidation(msg string) int {
	_, _ = fmt.Fprintln(e.stderr, "revue:", msg)
	return ExitValidation
}

// --- serve ---

func cmdServe(args []string) int {
	fs := newFlagSet("serve")
	repo := fs.String("repo", "", "repository to serve (default: enclosing repo)")
	idle := fs.Duration("idle-timeout", defaultIdleTimeout(), "shut down after this quiet period (0 disables)")
	bind := fs.String("bind", os.Getenv("REVUE_BIND"), "listen address (default 127.0.0.1; $REVUE_BIND)")
	port := fs.Int("port", envInt("REVUE_PORT"), "fixed listen port (default: recorded or ephemeral; $REVUE_PORT)")
	publicURL := fs.String("public-url", os.Getenv("REVUE_PUBLIC_URL"), "browser-facing base URL ($REVUE_PUBLIC_URL)")
	retentionFlag := fs.String("archive-retention", os.Getenv("REVUE_ARCHIVE_RETENTION"), "keep archived threads this long, 0 forever (default 90d; $REVUE_ARCHIVE_RETENTION)")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitValidation
	}
	retention := server.DefaultArchiveRetention
	if *retentionFlag != "" {
		var err error
		if retention, err = server.ParseRetention(*retentionFlag); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return ExitValidation
		}
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
		RepoRoot:         repoRoot,
		IdleTimeout:      *idle,
		Bind:             *bind,
		Port:             *port,
		PublicURL:        *publicURL,
		ArchiveRetention: retention,
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
