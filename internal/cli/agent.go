package cli

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/rphf/revue/internal/store"
)

// splitArgs separates positional arguments from the boolean flags a
// command accepts, anywhere before a bare "--"; what follows "--" is
// returned as is. The flag package stops at the first positional, so
// `reply 3 text` and `comment a.go:3 --old text` need this.
func splitArgs(args []string, flags map[string]*bool) (pos, rest []string, err error) {
	for i, a := range args {
		switch {
		case a == "--":
			return pos, args[i+1:], nil
		case strings.HasPrefix(a, "-") && a != "-":
			on, ok := flags[strings.TrimLeft(a, "-")]
			if !ok {
				return nil, nil, fmt.Errorf("unknown flag %s", a)
			}
			*on = true
		default:
			pos = append(pos, a)
		}
	}
	return pos, nil, nil
}

// body is the text argument, or stdin when there is none.
func body(pos []string, at int) (string, error) {
	if len(pos) > at {
		return strings.Join(pos[at:], " "), nil
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil || strings.TrimSpace(string(data)) == "" {
		return "", fmt.Errorf("text required: pass it as an argument or on stdin")
	}
	return string(data), nil
}

func threadID(s string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimPrefix(s, "#"), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid thread id %q", s)
	}
	return id, nil
}

// cmdReply posts an agent reply in a thread. The agent can reply but
// never resolve: there is no resolve command.
func (e *env) cmdReply(args []string) int {
	pos, _, err := splitArgs(args, nil)
	if err != nil {
		return e.failValidation(err.Error())
	}
	if len(pos) == 0 {
		return e.failValidation("usage: revue reply ID [TEXT]")
	}
	id, err := threadID(pos[0])
	if err != nil {
		return e.failValidation(err.Error())
	}
	text, err := body(pos, 1)
	if err != nil {
		return e.failValidation(err.Error())
	}
	if err := e.client.do("POST", fmt.Sprintf("/api/threads/%d/comments", id), map[string]any{
		"role": store.RoleAgent, "body": text,
	}, nil); err != nil {
		return e.fail(err)
	}
	return ExitOK
}

// location is PATH, PATH:LINE or PATH:START-END.
var location = regexp.MustCompile(`^(.+):(\d+)(?:-(\d+))?$`)

// cmdComment opens an agent thread on a line, a range, or a whole file,
// published at once, and prints its id. The thread is anchored in the
// diff the arguments after "--" name, the working tree by default.
func (e *env) cmdComment(args []string) int {
	var old bool
	pos, diffArgs, err := splitArgs(args, map[string]*bool{"old": &old})
	if err != nil {
		return e.failValidation(err.Error())
	}
	if len(pos) == 0 {
		return e.failValidation("usage: revue comment PATH[:LINE[-END]] [TEXT] [--old] [-- GIT-DIFF-ARGS]")
	}
	path, line, start := pos[0], 0, 0
	if m := location.FindStringSubmatch(pos[0]); m != nil {
		path = m[1]
		line, _ = strconv.Atoi(m[2])
		if m[3] != "" {
			start = line
			line, _ = strconv.Atoi(m[3])
		}
		if line < 1 || start > line {
			return e.failValidation(fmt.Sprintf("invalid line range in %q", pos[0]))
		}
	}
	text, err := body(pos, 1)
	if err != nil {
		return e.failValidation(err.Error())
	}
	side := store.SideAdditions
	if old {
		side = store.SideDeletions
	}
	if diffArgs == nil {
		diffArgs = []string{}
	}
	req := map[string]any{
		"role": store.RoleAgent, "args": diffArgs,
		"path": path, "side": side, "line": line, "body": text,
	}
	if start > 0 && start < line {
		req["startLine"] = start
	}
	var out struct {
		Thread struct {
			ID int64 `json:"id"`
		} `json:"thread"`
	}
	if err := e.client.do("POST", "/api/threads", req, &out); err != nil {
		return e.fail(err)
	}
	_, _ = fmt.Fprintln(e.stdout, out.Thread.ID)
	return ExitOK
}

// cmdArchive archives threads of this checkout: the named ones, the
// landed ones, the resolved and outdated ones, or all of them.
func (e *env) cmdArchive(args []string) int {
	var landed, resolved, all bool
	pos, _, err := splitArgs(args, map[string]*bool{"landed": &landed, "resolved": &resolved, "all": &all})
	if err != nil {
		return e.failValidation(err.Error())
	}
	selectors := 0
	for _, on := range []bool{len(pos) > 0, landed, resolved, all} {
		if on {
			selectors++
		}
	}
	if selectors != 1 {
		return e.failValidation("usage: revue archive ID... | --landed | --resolved | --all")
	}
	req := map[string]any{"landed": landed, "resolved": resolved, "all": all}
	if len(pos) > 0 {
		ids := make([]int64, len(pos))
		for i, p := range pos {
			if ids[i], err = threadID(p); err != nil {
				return e.failValidation(err.Error())
			}
		}
		req["ids"] = ids
	}
	var out struct {
		Archived []int64 `json:"archived"`
		Skipped  []int64 `json:"skipped"`
	}
	if err := e.client.do("POST", "/api/threads/archive", req, &out); err != nil {
		return e.fail(err)
	}
	if len(out.Archived) == 0 && len(out.Skipped) == 0 {
		_, _ = fmt.Fprintln(e.stdout, "archived: none")
	}
	writeIDs(e.stdout, "archived", out.Archived)
	writeIDs(e.stdout, "skipped (holds a draft)", out.Skipped)
	return ExitOK
}

// cmdUnarchive brings one archived thread back.
func (e *env) cmdUnarchive(args []string) int {
	pos, _, err := splitArgs(args, nil)
	if err != nil {
		return e.failValidation(err.Error())
	}
	if len(pos) != 1 {
		return e.failValidation("usage: revue unarchive ID")
	}
	id, err := threadID(pos[0])
	if err != nil {
		return e.failValidation(err.Error())
	}
	if err := e.client.do("POST", fmt.Sprintf("/api/threads/%d/unarchive", id), nil, nil); err != nil {
		return e.fail(err)
	}
	return ExitOK
}
