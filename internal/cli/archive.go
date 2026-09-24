package cli

import (
	"fmt"
	"io"
	"strconv"

	"github.com/rphf/revue/internal/server"
)

// threadIDs collects a repeated --thread flag.
type threadIDs []int64

func (t *threadIDs) String() string { return fmt.Sprint(*t) }

func (t *threadIDs) Set(v string) error {
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return fmt.Errorf("invalid thread id %q", v)
	}
	*t = append(*t, n)
	return nil
}

// cmdArchive archives threads of this checkout: the named ones, the
// landed ones, the resolved and outdated ones, or all of them.
func (e *env) cmdArchive(args []string) int {
	fs := newFlagSet("archive")
	var ids threadIDs
	fs.Var(&ids, "thread", "thread id to archive (repeatable)")
	landed := fs.Bool("landed", false, "archive the threads whose code landed")
	resolved := fs.Bool("resolved", false, "archive resolved and outdated threads")
	all := fs.Bool("all", false, "archive every thread of this branch")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	selectors := 0
	for _, on := range []bool{len(ids) > 0, *landed, *resolved, *all} {
		if on {
			selectors++
		}
	}
	if selectors != 1 {
		return e.failValidation("pass one of --thread, --landed, --resolved, --all")
	}
	body := map[string]any{"landed": *landed, "resolved": *resolved, "all": *all}
	if len(ids) > 0 {
		body["ids"] = ids
	}
	var out map[string]any
	if err := e.client.do("POST", "/api/threads/archive", body, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}

// cmdUnarchive brings one archived thread back.
func (e *env) cmdUnarchive(args []string) int {
	fs := newFlagSet("unarchive")
	thread := fs.Int64("thread", 0, "thread id (required)")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	if *thread <= 0 {
		return e.failValidation("--thread is required")
	}
	var out map[string]any
	if err := e.client.do("POST", fmt.Sprintf("/api/threads/%d/unarchive", *thread), nil, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}

// cmdPrune removes the data of repositories that no longer exist. It
// needs no server and starts none.
func cmdPrune(args []string, stdout, stderr io.Writer) int {
	fs := newFlagSet("prune")
	dryRun := fs.Bool("dry-run", false, "list what would be removed, remove nothing")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return ExitValidation
	}
	entries, err := server.Prune(*dryRun)
	for _, en := range entries {
		switch en.Status {
		case server.PruneRemoved:
			verb := "removed"
			if *dryRun {
				verb = "would remove"
			}
			_, _ = fmt.Fprintf(stdout, "%s %s (%s no longer exists)\n", verb, en.Dir, en.Repo)
		case server.PruneRunning:
			_, _ = fmt.Fprintf(stdout, "kept %s: %s is gone but its server still runs; run revue stop --all first\n", en.Dir, en.Repo)
		case server.PruneUnknown:
			_, _ = fmt.Fprintf(stdout, "kept %s: it does not record its repository\n", en.Dir)
		}
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return ExitError
	}
	if len(entries) == 0 {
		_, _ = fmt.Fprintln(stdout, "nothing to prune")
	}
	return ExitOK
}
