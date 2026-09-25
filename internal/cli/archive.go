package cli

import (
	"fmt"
	"io"

	"github.com/rphf/revue/internal/server"
)

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
