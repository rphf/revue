package gitx

import (
	"errors"
	"os"
	"strings"
)

// LastSendRef holds the working tree as it was at the reviewer's last
// send, as a commit on no branch. A plain push leaves it behind.
const LastSendRef = "refs/revue/last-send"

// ErrNoCheckpoint rejects the diff since the last send before any send.
var ErrNoCheckpoint = errors.New("nothing sent yet: the diff since the last send starts with the first send")

// commit-tree needs an identity; the repository may have none set.
var checkpointIdent = []string{
	"GIT_AUTHOR_NAME=revue", "GIT_AUTHOR_EMAIL=revue@localhost",
	"GIT_COMMITTER_NAME=revue", "GIT_COMMITTER_EMAIL=revue@localhost",
}

// Checkpoint records the working tree under LastSendRef, untracked
// files included and ignored ones left out. It goes through a copy of
// the index, so the index, the working tree and the branch stay as
// they are.
func Checkpoint(repoRoot string) error {
	env, done, err := scratchIndex(repoRoot)
	if err != nil {
		return err
	}
	defer done()
	if _, err := runGitEnv(repoRoot, env, nil, false, "add", "-A"); err != nil {
		return err
	}
	tree, err := runGitEnv(repoRoot, env, nil, false, "write-tree")
	if err != nil {
		return err
	}
	args := []string{"commit-tree", "-m", "revue: the working tree at a send"}
	if head, ok := ResolveRef(repoRoot, "HEAD"); ok {
		args = append(args, "-p", head)
	}
	commit, err := runGitEnv(repoRoot, checkpointIdent, nil, false, append(args, strings.TrimSpace(string(tree)))...)
	if err != nil {
		return err
	}
	_, err = git(repoRoot, "update-ref", LastSendRef, strings.TrimSpace(string(commit)))
	return err
}

// isCheckpointCapture reports whether args diff the last send's
// checkpoint against the working tree.
func isCheckpointCapture(args []string) bool {
	return len(args) > 0 && args[0] == LastSendRef && (len(args) == 1 || args[1] == "--")
}

// diffEnv is the environment a diff of args runs in, with a cleanup to
// call after. A checkpoint diff reads a copy of the index where
// untracked files are marked intent-to-add: git then compares them with
// the checkpoint instead of calling them deleted or leaving new ones
// out.
func diffEnv(repoRoot string, args []string) ([]string, func(), error) {
	if !isCheckpointCapture(args) {
		return nil, func() {}, nil
	}
	if _, ok := ResolveRef(repoRoot, LastSendRef); !ok {
		return nil, nil, ErrNoCheckpoint
	}
	env, done, err := scratchIndex(repoRoot)
	if err != nil {
		return nil, nil, err
	}
	if _, err := runGitEnv(repoRoot, env, nil, false, "add", "--intent-to-add", "--all"); err != nil {
		done()
		return nil, nil, err
	}
	return env, done, nil
}

// scratchIndex copies the index to a temporary file and returns the
// environment that points git at it, with a cleanup that removes it.
func scratchIndex(repoRoot string) ([]string, func(), error) {
	out, err := git(repoRoot, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(strings.TrimSpace(string(out)))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	f, err := os.CreateTemp("", "revue-index-*")
	if err != nil {
		return nil, nil, err
	}
	name := f.Name()
	_, werr := f.Write(data)
	cerr := f.Close()
	done := func() { _ = os.Remove(name) }
	if err := errors.Join(werr, cerr); err != nil {
		done()
		return nil, nil, err
	}
	// git refuses an empty index file but creates a missing one.
	if len(data) == 0 {
		done()
	}
	return []string{"GIT_INDEX_FILE=" + name}, done, nil
}
