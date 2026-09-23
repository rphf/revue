package server

import (
	"fmt"
	"maps"
	"net/http"
	"path/filepath"
	"slices"
	"strings"

	"github.com/rphf/revue/internal/store"
)

// handleExport renders the threads as markdown: grouped by file, each
// with its quoted snapshot and every sent comment. Drafts stay out.
func (s *Server) handleExport(w http.ResponseWriter, _ *http.Request) {
	md, err := renderExport(s.store, filepath.Base(s.repoRoot))
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(md))
}

func renderExport(st *store.Store, repo string) (string, error) {
	views, err := threadViews(st, false, true, false)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# Threads in %s\n\n", repo)
	if len(views) == 0 {
		b.WriteString("No sent threads.\n")
		return b.String(), nil
	}
	unresolved := 0
	for _, v := range views {
		if !v.Resolved {
			unresolved++
		}
	}
	fmt.Fprintf(&b, "- Threads: %d, %d unresolved\n", len(views), unresolved)

	byFile := map[string][]*threadView{}
	for _, v := range views {
		byFile[v.Path] = append(byFile[v.Path], v)
	}
	for _, path := range slices.Sorted(maps.Keys(byFile)) {
		fmt.Fprintf(&b, "\n## %s\n", path)
		for _, v := range byFile[path] {
			writeThread(&b, v)
		}
	}
	return b.String(), nil
}

func writeThread(b *strings.Builder, v *threadView) {
	label := ""
	if v.Resolved {
		label = " (resolved)"
	}
	fmt.Fprintf(b, "\n### Thread %d%s\n\n", v.ID, label)

	lines := fmt.Sprint(v.Line)
	if v.StartLine != nil && *v.StartLine != v.Line {
		lines = fmt.Sprintf("%d-%d", *v.StartLine, v.Line)
	}
	fmt.Fprintf(b, "`%s:%s` (%s, %s)\n", v.Path, lines, v.Side, v.CreatedAt.UTC().Format("2006-01-02 15:04 UTC"))
	if q := v.Quote; q != nil {
		fence := codeFence(q.Lines)
		fmt.Fprintf(b, "\n%s\n%s\n%s\n", fence, strings.Join(q.Lines, "\n"), fence)
	}

	for _, c := range v.Comments {
		fmt.Fprintf(b, "\n**%s** (%s):\n\n%s\n",
			c.AuthorRole, c.CreatedAt.UTC().Format("2006-01-02 15:04 UTC"), strings.TrimRight(c.Body, "\n"))
	}
}

// codeFence is a backtick run longer than any inside the quoted lines,
// so quoted markdown cannot close the block early.
func codeFence(lines []string) string {
	longest := 2
	for _, line := range lines {
		run := 0
		for _, r := range line {
			if r == '`' {
				run++
				if run > longest {
					longest = run
				}
			} else {
				run = 0
			}
		}
	}
	return strings.Repeat("`", longest+1)
}
