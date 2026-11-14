package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// A session is one run of an agent, named by the harness that runs it
// in REVUE_SESSION. Revue notes the repositories each session works in,
// so the harness can show and deliver a session the reviews it handles,
// which are not always the one of its working directory. One file per
// session lists its repositories, one per line.

// sessionMaxAge is how long a session's file outlasts its last command.
const sessionMaxAge = 30 * 24 * time.Hour

func sessionsDir() (string, error) {
	base, err := stateBase()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "sessions"), nil
}

// sessionPath names a session's file by a hash of its id: the id is the
// harness's and may hold anything.
func sessionPath(id string) (string, error) {
	dir, err := sessionsDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(dir, hex.EncodeToString(sum[:8])), nil
}

// SessionRepos lists the repositories the session ran revue in, oldest
// first. A session revue never saw has none.
func SessionRepos(id string) ([]string, error) {
	path, err := sessionPath(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var repos []string
	for line := range strings.SplitSeq(string(data), "\n") {
		if line != "" {
			repos = append(repos, line)
		}
	}
	return repos, nil
}

// RecordSession notes that the session ran revue in the repository. It
// also drops the files of sessions long gone.
func RecordSession(id, repoRoot string) error {
	path, err := sessionPath(id)
	if err != nil {
		return err
	}
	repos, err := SessionRepos(id)
	if err != nil {
		return err
	}
	if slices.Contains(repos, repoRoot) {
		now := time.Now()
		return os.Chtimes(path, now, now)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// Written whole and renamed, so a reader never sees half a list.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-*")
	if err != nil {
		return err
	}
	_, werr := tmp.WriteString(strings.Join(append(repos, repoRoot), "\n") + "\n")
	cerr := tmp.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	sweepSessions(filepath.Dir(path))
	return nil
}

func sweepSessions(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > sessionMaxAge {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
