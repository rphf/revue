package gitx

import (
	"errors"
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

// WorkingTree writes the working tree as a git tree, untracked files
// included and ignored ones left out, and returns its hash. It goes
// through a copy of the index, so the index, the working tree and the
// branch stay as they are.
func WorkingTree(repoRoot string) (string, error) {
	env, done, err := scratchIndex(repoRoot)
	if err != nil {
		return "", err
	}
	defer done()
	if _, err := runGitEnv(repoRoot, env, nil, false, "add", "-A"); err != nil {
		return "", err
	}
	tree, err := runGitEnv(repoRoot, env, nil, false, "write-tree")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(tree)), nil
}

// Checkpoint records tree, from WorkingTree, under LastSendRef.
func Checkpoint(repoRoot, tree string) error {
	args := []string{"commit-tree", "-m", "revue: the working tree at a send"}
	if head, ok := ResolveRef(repoRoot, "HEAD"); ok {
		args = append(args, "-p", head)
	}
	commit, err := runGitEnv(repoRoot, checkpointIdent, nil, false, append(args, tree)...)
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
// call after. A diff whose new side is the working tree reads a copy of
// the index where untracked files are marked intent-to-add: git then
// diffs them with everything else, so a deleted file and its recreated
// copy pair up as a rename. untracked reports whether it did.
func diffEnv(repoRoot string, args []string) (env []string, done func(), untracked bool, err error) {
	if isCheckpointCapture(args) {
		env, done, err := checkpointEnv(repoRoot)
		return env, done, false, err
	}
	noop := func() {}
	if !isWorkingTreeCapture(args) {
		return nil, noop, false, nil
	}
	files, err := listUntracked(repoRoot, pathspecs(args))
	if err != nil || len(files) == 0 {
		return nil, noop, false, err
	}
	env, done, err = scratchIndex(repoRoot)
	if err != nil {
		return nil, nil, false, err
	}
	// Only the untracked files: --all would record deletions too, and
	// hide them from the diff. The names are literal, not patterns.
	env = append(env, "GIT_LITERAL_PATHSPECS=1")
	stdin := []byte(strings.Join(files, "\x00"))
	if _, err := runGitEnv(repoRoot, env, stdin, false, "add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"); err != nil {
		done()
		return nil, nil, false, err
	}
	return env, done, true, nil
}

// checkpointEnv is the environment of a diff since the last send: a
// copy of the index where every untracked file is marked intent-to-add,
// so git compares them with the checkpoint instead of calling them
// deleted or leaving new ones out.
func checkpointEnv(repoRoot string) ([]string, func(), error) {
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

// listUntracked lists the untracked files git does not ignore, within
// paths when given.
func listUntracked(repoRoot string, paths []string) ([]string, error) {
	args := []string{"ls-files", "--others", "--exclude-standard", "-z"}
	if len(paths) > 0 {
		args = append(append(args, "--"), paths...)
	}
	out, err := git(repoRoot, args...)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, p := range strings.Split(string(out), "\x00") {
		if p != "" {
			files = append(files, p)
		}
	}
	return files, nil
}
