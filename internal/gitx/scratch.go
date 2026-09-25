package gitx

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Scratch indexes are temporary files named revue-index-<pid>-*, next to
// which git may leave a .lock while it writes. Each is removed when its
// diff is done; RemoveScratch removes those still open at shutdown, and
// SweepScratch those a killed process left behind.
const scratchPrefix = "revue-index-"

// scratchMaxAge bounds how long a scratch file may live whatever its
// process: no diff takes this long, and a reused pid must not keep a
// leftover forever.
const scratchMaxAge = time.Hour

// scratchOpen maps each open scratch file to its repository.
var scratchOpen = struct {
	sync.Mutex
	repos map[string]string
}{repos: map[string]string{}}

// scratchIndex copies the index to a temporary file and returns the
// environment that points git at it, with a cleanup that removes it and
// any lock git left next to it.
func scratchIndex(repoRoot string) ([]string, func(), error) {
	out, err := git(repoRoot, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(strings.TrimSpace(string(out)))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	f, err := os.CreateTemp("", fmt.Sprintf("%s%d-*", scratchPrefix, os.Getpid()))
	if err != nil {
		return nil, nil, err
	}
	name := f.Name()
	scratchOpen.Lock()
	scratchOpen.repos[name] = repoRoot
	scratchOpen.Unlock()
	done := func() {
		removeScratch(name)
		scratchOpen.Lock()
		delete(scratchOpen.repos, name)
		scratchOpen.Unlock()
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if err := errors.Join(werr, cerr); err != nil {
		done()
		return nil, nil, err
	}
	// git refuses an empty index file but creates a missing one; the
	// name stays registered, so done still removes what git writes.
	if len(data) == 0 {
		removeScratch(name)
	}
	return []string{"GIT_INDEX_FILE=" + name}, done, nil
}

func removeScratch(name string) {
	_ = os.Remove(name)
	_ = os.Remove(name + ".lock")
}

// RemoveScratch removes the scratch indexes of the repository's diffs
// still running, for a server that is shutting down: their git commands
// fail, which no one waits for any more.
func RemoveScratch(repoRoot string) {
	scratchOpen.Lock()
	defer scratchOpen.Unlock()
	for name, repo := range scratchOpen.repos {
		if repo == repoRoot {
			removeScratch(name)
			delete(scratchOpen.repos, name)
		}
	}
}

// SweepScratch removes the scratch files, and their locks, that no live
// process owns: those of a process that was killed, or older than
// scratchMaxAge. It reports how many it removed.
func SweepScratch() int {
	dir := os.TempDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		name := e.Name()
		rest, ok := strings.CutPrefix(name, scratchPrefix)
		if !ok {
			continue
		}
		pidText, _, _ := strings.Cut(rest, "-")
		pid, err := strconv.Atoi(pidText)
		info, ierr := e.Info()
		old := ierr == nil && time.Since(info.ModTime()) > scratchMaxAge
		live := err == nil && (pid == os.Getpid() || processAlive(pid))
		if live && !old {
			continue
		}
		if os.Remove(filepath.Join(dir, name)) == nil {
			removed++
		}
	}
	return removed
}

// processAlive reports whether a process with this pid runs.
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// FindProcess fails on Windows when the process is gone; elsewhere it
	// always succeeds, and signal 0 asks without sending anything.
	if runtime.GOOS == "windows" {
		return true
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, os.ErrPermission)
}
