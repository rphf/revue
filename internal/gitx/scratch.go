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
// diff is done, except the one a repository's diffs share, which lives
// as long as its process; RemoveScratch removes those still open at
// shutdown, and SweepScratch those a killed process left behind.
const scratchPrefix = "revue-index-"

// scratchMaxAge bounds how long the scratch file of one diff may live
// whatever its process: no diff takes this long, and a reused pid must not keep a
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
	index, err := indexPath(repoRoot)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.CreateTemp("", fmt.Sprintf("%s%d-*", scratchPrefix, os.Getpid()))
	if err != nil {
		return nil, nil, err
	}
	name := f.Name()
	register(name, repoRoot)
	done := func() {
		removeScratch(name)
		unregister(name)
	}
	if err := copyIndex(index, f); err != nil {
		done()
		return nil, nil, err
	}
	return []string{"GIT_INDEX_FILE=" + name}, done, nil
}

// copyIndex copies the index to f and closes it. git refuses an empty
// index file but creates a missing one, so a missing or empty index
// leaves no file: the name stays registered, so its cleanup still
// removes what git writes.
func copyIndex(index string, f *os.File) error {
	name := f.Name()
	// The time before the content: should the index change in between,
	// the copy looks older, which only makes git check more by content.
	info, statErr := os.Stat(index)
	data, err := os.ReadFile(index)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = f.Close()
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	// The copy keeps the index's time: git trusts a file's stat only when
	// the index is newer than the file, so a fresh copy would hide an edit
	// of the same size made in the second of the last index write.
	var terr error
	if statErr == nil {
		terr = os.Chtimes(name, info.ModTime(), info.ModTime())
	}
	if err := errors.Join(werr, cerr, terr); err != nil {
		return err
	}
	if len(data) == 0 {
		removeScratch(name)
	}
	return nil
}

func indexPath(repoRoot string) (string, error) {
	out, err := git(repoRoot, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func register(name, repoRoot string) {
	scratchOpen.Lock()
	scratchOpen.repos[name] = repoRoot
	scratchOpen.Unlock()
}

func unregister(name string) {
	scratchOpen.Lock()
	delete(scratchOpen.repos, name)
	scratchOpen.Unlock()
}

// sharedMarker names the scratch index that the diffs of a repository
// which only read the index share. It lives as long as its process, so
// SweepScratch leaves it to that process whatever its age.
const sharedMarker = "shared-"

// sharedIndexes maps each repository to its shared scratch index.
var sharedIndexes = struct {
	sync.Mutex
	repos map[string]*sharedIndex
}{repos: map[string]*sharedIndex{}}

// sharedIndex is a copy of a repository's index that diffs reuse. git
// writes its refresh into the copy and the next diff starts from it, so
// a file whose stat changed but not its content is hashed once, not on
// every poll. The copy is made again when the repository's index
// changes: a diff holds the read lock, a new copy the write lock.
type sharedIndex struct {
	sync.RWMutex
	index string      // the repository's index
	name  string      // the copy, once made
	from  os.FileInfo // the index the copy was made from
}

// sharedScratch returns the environment of a diff that reads the index
// and writes only git's refresh to it, with a release to call when the
// diff is done.
func sharedScratch(repoRoot string) ([]string, func(), error) {
	sharedIndexes.Lock()
	s := sharedIndexes.repos[repoRoot]
	if s == nil {
		s = &sharedIndex{}
		sharedIndexes.repos[repoRoot] = s
	}
	sharedIndexes.Unlock()

	s.Lock()
	if s.index == "" {
		index, err := indexPath(repoRoot)
		if err != nil {
			s.Unlock()
			return nil, nil, err
		}
		s.index = index
	}
	info, err := os.Stat(s.index)
	if err != nil {
		s.Unlock()
		// No index yet: a copy of its own, which git creates.
		return scratchIndex(repoRoot)
	}
	if err := s.refresh(repoRoot, info); err != nil {
		s.Unlock()
		return nil, nil, err
	}
	name := s.name
	s.Unlock()
	// Another diff may copy the index again in between; that copy is as
	// good as this one.
	s.RLock()
	return []string{"GIT_INDEX_FILE=" + name}, s.RUnlock, nil
}

// refresh copies the index again when it changed since the last copy,
// or when the copy is gone. The caller holds the write lock.
func (s *sharedIndex) refresh(repoRoot string, info os.FileInfo) error {
	if s.name != "" && s.from != nil && os.SameFile(s.from, info) &&
		s.from.ModTime().Equal(info.ModTime()) && s.from.Size() == info.Size() {
		if _, err := os.Stat(s.name); err == nil {
			return nil
		}
	}
	var f *os.File
	var err error
	if s.name == "" {
		f, err = os.CreateTemp("", fmt.Sprintf("%s%d-%s*", scratchPrefix, os.Getpid(), sharedMarker))
		if err == nil {
			s.name = f.Name()
			register(s.name, repoRoot)
		}
	} else {
		_ = os.Remove(s.name + ".lock")
		f, err = os.Create(s.name)
	}
	if err != nil {
		return err
	}
	s.from = nil
	if err := copyIndex(s.index, f); err != nil {
		return err
	}
	s.from = info
	return nil
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
	sharedIndexes.Lock()
	delete(sharedIndexes.repos, repoRoot)
	sharedIndexes.Unlock()
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
		pidText, after, _ := strings.Cut(rest, "-")
		pid, err := strconv.Atoi(pidText)
		info, ierr := e.Info()
		old := ierr == nil && time.Since(info.ModTime()) > scratchMaxAge &&
			!strings.HasPrefix(after, sharedMarker)
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
