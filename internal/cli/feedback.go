package cli

import (
	"fmt"
)

// cmdFeedback is the agent's cursor read (R10, R13): everything since
// --since — events, visible threads with quoted snapshot context, and
// the verdict, so the agent can tell "answer the comments" from
// "implement the changes" from "done". Drafts are never present.
func (e *env) cmdFeedback(args []string) int {
	fs := newFlagSet("feedback")
	review := fs.Int64("review", 0, "review id (default: single open review for this branch)")
	since := fs.Int64("since", 0, "cursor: return events after this id")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	id, code := e.resolveReview(*review)
	if code != ExitOK {
		return code
	}
	var out map[string]any
	if err := e.client.do("GET", fmt.Sprintf("/api/reviews/%d/feedback?since=%d", id, *since), nil, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}
