package server

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/rphf/revue/internal/store"
)

// Prune outcomes.
const (
	PruneRemoved = "removed"
	PruneUnknown = "unknown" // the database does not say which repository it serves
	PruneRunning = "running" // the repository is gone but its server still answers
)

// PruneEntry is one data directory Prune acted on or kept on purpose.
type PruneEntry struct {
	Dir    string `json:"dir"`
	Repo   string `json:"repo,omitempty"`
	Status string `json:"status"`
}

// Prune removes the data and state directories of repositories that no
// longer exist. A directory whose database does not record its
// repository is reported and kept. With dryRun nothing is removed.
func Prune(dryRun bool) ([]PruneEntry, error) {
	dataBase, err := dataBaseDir()
	if err != nil {
		return nil, err
	}
	stateBaseDir, err := stateBase()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dataBase)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := []PruneEntry{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(dataBase, e.Name())
		db := filepath.Join(dir, "revue.db")
		if _, err := os.Stat(db); err != nil {
			continue
		}
		raw, ok, err := store.ReadSetting(db, settingRepo)
		var repo string
		if err != nil || !ok || json.Unmarshal([]byte(raw), &repo) != nil || repo == "" {
			out = append(out, PruneEntry{Dir: dir, Status: PruneUnknown})
			continue
		}
		if _, err := os.Stat(repo); err == nil {
			continue
		}
		stateDir := filepath.Join(stateBaseDir, e.Name())
		if st, err := ReadState(stateDir); err == nil && Healthy(st) {
			out = append(out, PruneEntry{Dir: dir, Repo: repo, Status: PruneRunning})
			continue
		}
		if !dryRun {
			if err := os.RemoveAll(dir); err != nil {
				return out, err
			}
			if stateDir != dir {
				if err := os.RemoveAll(stateDir); err != nil {
					return out, err
				}
			}
		}
		out = append(out, PruneEntry{Dir: dir, Repo: repo, Status: PruneRemoved})
	}
	return out, nil
}

// dataBaseDir is the directory holding every repository's data dir.
func dataBaseDir() (string, error) {
	if base := os.Getenv("REVUE_DATA_DIR"); base != "" {
		return base, nil
	}
	base, err := xdgDir("XDG_DATA_HOME", filepath.Join(".local", "share"))
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "revue"), nil
}
