package gitx

import (
	"strings"
)

// Fold reasons: why a file starts folded in the diff, from the
// linguist attributes GitHub reads in .gitattributes.
const (
	FoldGenerated = "generated"
	FoldVendored  = "vendored"
)

// Folds reads the linguist-generated and linguist-vendored attributes
// of paths, from the .gitattributes files of the working tree, and
// returns the fold reason of each path that has one. An attribute
// counts when it is set or "true"; "-attr" and "attr=false" turn it
// off, as in Linguist. A generated file reads as generated, even when
// it is vendored too.
func Folds(repoRoot string, paths []string) (map[string]string, error) {
	folds := map[string]string{}
	if len(paths) == 0 {
		return folds, nil
	}
	stdin := []byte(strings.Join(paths, "\x00") + "\x00")
	out, err := runGit(repoRoot, stdin, false,
		"check-attr", "-z", "--stdin", "linguist-generated", "linguist-vendored")
	if err != nil {
		return nil, err
	}
	// Each answer is "<path>\0<attribute>\0<value>\0".
	fields := strings.Split(string(out), "\x00")
	for i := 0; i+2 < len(fields); i += 3 {
		path, attr, value := fields[i], fields[i+1], fields[i+2]
		if value != "set" && value != "true" {
			continue
		}
		switch attr {
		case "linguist-generated":
			folds[path] = FoldGenerated
		case "linguist-vendored":
			if folds[path] == "" {
				folds[path] = FoldVendored
			}
		}
	}
	return folds, nil
}
