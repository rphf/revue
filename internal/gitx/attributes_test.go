package gitx

import (
	"maps"
	"testing"

	"github.com/rphf/revue/internal/gittest"
)

func TestFolds(t *testing.T) {
	repo := gittest.Init(t)
	write(t, repo, ".gitattributes", `*.generated.ts linguist-generated
/vendor/**      linguist-vendored
/vendor/gen.js  linguist-generated=true
yarn.lock       linguist-generated
/keep.min.js    -linguist-generated
/off.lock       linguist-generated=false
`)
	commitAll(t, repo, "attributes")

	paths := []string{
		"a.generated.ts", "src/b.generated.ts", "vendor/lib/x.js", "vendor/gen.js",
		"web/yarn.lock", "keep.min.js", "off.lock", "main.go",
	}
	got, err := Folds(repo, paths)
	if err != nil {
		t.Fatalf("Folds: %v", err)
	}
	want := map[string]string{
		"a.generated.ts":     FoldGenerated,
		"src/b.generated.ts": FoldGenerated,
		"vendor/lib/x.js":    FoldVendored,
		"vendor/gen.js":      FoldGenerated,
		"web/yarn.lock":      FoldGenerated,
	}
	if !maps.Equal(got, want) {
		t.Errorf("Folds = %v, want %v", got, want)
	}
}

func TestFoldsNoPaths(t *testing.T) {
	got, err := Folds(gittest.Init(t), nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("Folds(nil) = %v, %v", got, err)
	}
}
