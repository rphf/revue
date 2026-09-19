package server

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/rphf/revue/internal/store"
)

// handleExport renders a review as markdown (R14): source and verdicts
// first, then threads grouped by file with quoted snapshot context and
// every submitted comment. Drafts stay out of it.
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	md, err := renderExport(s.store, review)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(md))
}

func renderExport(st *store.Store, review *store.Review) (string, error) {
	rounds, err := st.ListRounds(review.ID)
	if err != nil {
		return "", err
	}
	roundSeq := map[int64]int{}
	for _, rd := range rounds {
		roundSeq[rd.ID] = rd.Seq
	}
	subs, err := st.SubmissionsForReview(review.ID)
	if err != nil {
		return "", err
	}
	views, err := threadViews(st, review, false, true)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# Review #%d on %s\n\n", review.ID, review.Branch)
	fmt.Fprintf(&b, "- Source: `%s`\n", sourceCommand(review.SourceArgs))
	fmt.Fprintf(&b, "- State: %s\n", review.State)
	fmt.Fprintf(&b, "- Rounds: %d\n", len(rounds))
	if len(subs) == 0 {
		b.WriteString("- Verdicts: none yet\n")
	} else {
		b.WriteString("- Verdicts:\n")
		for _, sub := range subs {
			fmt.Fprintf(&b, "  - Round %d: %s", roundSeq[sub.RoundID], verdictLabel(sub.Verdict))
			if sub.Summary != "" {
				fmt.Fprintf(&b, ": %s", sub.Summary)
			}
			b.WriteString("\n")
		}
	}

	if len(views) == 0 {
		b.WriteString("\nNo submitted threads.\n")
		return b.String(), nil
	}
	byFile := map[string][]*threadView{}
	for _, v := range views {
		path := threadPath(v)
		byFile[path] = append(byFile[path], v)
	}
	paths := make([]string, 0, len(byFile))
	for path := range byFile {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		fmt.Fprintf(&b, "\n## %s\n", path)
		for _, v := range byFile[path] {
			writeThread(&b, v, roundSeq)
		}
	}
	return b.String(), nil
}

func writeThread(b *strings.Builder, v *threadView, roundSeq map[int64]int) {
	labels := []string{fmt.Sprintf("round %d", v.OriginRoundSeq)}
	latest := latestAnchor(v.Anchors)
	if latest != nil && latest.State == store.AnchorOutdated {
		labels = append(labels, fmt.Sprintf("outdated in round %d", roundSeq[latest.RoundID]))
	}
	if v.Resolved {
		labels = append(labels, "resolved")
	}
	fmt.Fprintf(b, "\n### Thread %d (%s)\n\n", v.ID, strings.Join(labels, ", "))

	if q := v.Quote; q != nil {
		lines := fmt.Sprint(q.Line)
		if q.StartLine != q.Line {
			lines = fmt.Sprintf("%d-%d", q.StartLine, q.Line)
		}
		fence := codeFence(q.Lines)
		fmt.Fprintf(b, "`%s:%s` (%s, round %d)\n\n%s\n%s\n%s\n",
			q.Path, lines, q.Side, q.RoundSeq, fence, strings.Join(q.Lines, "\n"), fence)
	} else if latest != nil {
		fmt.Fprintf(b, "`%s:%d` (%s)\n", latest.Path, latest.Line, latest.Side)
	}

	for _, c := range v.Comments {
		fmt.Fprintf(b, "\n**%s** (%s):\n\n%s\n",
			c.AuthorRole, c.CreatedAt.UTC().Format("2006-01-02 15:04 UTC"), strings.TrimRight(c.Body, "\n"))
	}
}

// latestAnchor is where the thread sits now: the anchor from the most
// recent round.
func latestAnchor(anchors []*store.ThreadAnchor) *store.ThreadAnchor {
	var latest *store.ThreadAnchor
	for _, a := range anchors {
		if latest == nil || a.RoundID > latest.RoundID {
			latest = a
		}
	}
	return latest
}

func threadPath(v *threadView) string {
	if a := latestAnchor(v.Anchors); a != nil {
		return a.Path
	}
	if v.Quote != nil {
		return v.Quote.Path
	}
	return "(unanchored)"
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

func sourceCommand(args []string) string {
	if len(args) == 0 {
		return "git diff (working tree, untracked files included)"
	}
	return "git diff " + strings.Join(args, " ")
}

func verdictLabel(verdict string) string {
	if verdict == store.VerdictRequestChanges {
		return "request changes"
	}
	return verdict
}
