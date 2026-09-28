package cli

import (
	"fmt"
	"os"
	"strings"
)

// cmdNote writes the agent's note to the reviewer for the checked-out
// branch, replacing the one before: TEXT, the file --file names, or
// stdin. --clear removes it. It prints nothing.
func (e *env) cmdNote(args []string) int {
	clear, file, pos, err := noteArgs(args)
	if err != nil {
		return e.failValidation(err.Error())
	}
	if clear {
		if len(pos) > 0 || file != "" {
			return e.failValidation("--clear takes no text")
		}
		if err := e.client.do("DELETE", "/api/note", nil, nil); err != nil {
			return e.fail(err)
		}
		return ExitOK
	}
	var text string
	switch {
	case file != "" && len(pos) > 0:
		return e.failValidation("pass the note as TEXT or --file, not both")
	case file != "":
		data, err := os.ReadFile(file)
		if err != nil {
			return e.failValidation(err.Error())
		}
		text = string(data)
	default:
		var err error
		if text, err = body(pos, 0); err != nil {
			return e.failValidation(err.Error())
		}
	}
	if err := e.client.do("PUT", "/api/note", map[string]any{"body": text}, nil); err != nil {
		return e.fail(err)
	}
	return ExitOK
}

// noteArgs reads --clear and --file PATH, and takes everything else as
// the text: a markdown list starts with a dash, which a flag parser
// would refuse as an unknown flag.
func noteArgs(args []string) (clear bool, file string, pos []string, err error) {
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--clear" || a == "-clear":
			clear = true
		case a == "--file" || a == "-file":
			if i+1 == len(args) {
				return false, "", nil, fmt.Errorf("--file needs a path")
			}
			i++
			file = args[i]
		case strings.HasPrefix(a, "--file="):
			file = strings.TrimPrefix(a, "--file=")
		default:
			pos = append(pos, a)
		}
	}
	return clear, file, pos, nil
}
