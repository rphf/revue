package cli

import (
	"encoding/json"
	"fmt"
)

func unmarshalAPIError(data []byte, apiErr *APIError) {
	_ = json.Unmarshal(data, apiErr)
}

// cmdFeedback is the agent's cursor read: everything since --since
// (events; drafts never appear), every unresolved thread with its sent
// comments and quoted snapshot, and the reviewer's last send with its
// note, so the agent can tell "answer this" from "change that".
func (e *env) cmdFeedback(args []string) int {
	fs := newFlagSet("feedback")
	since := fs.Int64("since", 0, "cursor: return events after this id")
	if err := fs.Parse(args); err != nil {
		return e.failValidation(err.Error())
	}
	var out map[string]any
	if err := e.client.do("GET", fmt.Sprintf("/api/feedback?since=%d", *since), nil, &out); err != nil {
		return e.fail(err)
	}
	return e.printJSON(out)
}
