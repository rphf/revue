package server

import (
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/rphf/revue/internal/store"
)

// Image types the rich markdown view may embed. Anything else is refused,
// so this stays an image endpoint rather than a file server.
var assetTypes = map[string]string{
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
}

// handleRoundAsset serves an image that a markdown file references, for
// the rich view. The round's snapshot wins when the image changed in that
// round; otherwise the file comes from the repository on disk, which is
// what the reviewer has checked out. The response can never act as a
// page: SVG may carry script, so it is sandboxed and never sniffed.
func (s *Server) handleRoundAsset(w http.ResponseWriter, r *http.Request) {
	review, ok := s.reviewFromPath(w, r)
	if !ok {
		return
	}
	round, ok := s.roundFromPath(w, r, review)
	if !ok {
		return
	}
	p, ok := cleanRepoPath(r.URL.Query().Get("path"))
	if !ok {
		httpError(w, http.StatusBadRequest, "validation", "path must be a relative file path inside the repository")
		return
	}
	ctype, ok := assetTypes[strings.ToLower(path.Ext(p))]
	if !ok {
		httpError(w, http.StatusUnsupportedMediaType, "unsupported_type", "only image files are served")
		return
	}
	content, err := s.roundAsset(round.ID, p)
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, "not_found", "no such file in this round")
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

// cleanRepoPath accepts a slash-separated path inside the repository and
// nothing else: no absolute path, no parent segment, no empty result.
func cleanRepoPath(raw string) (string, bool) {
	if raw == "" || strings.HasPrefix(raw, "/") || strings.ContainsAny(raw, "\\\x00") {
		return "", false
	}
	p := path.Clean(raw)
	if p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return "", false
	}
	return p, true
}

// roundAsset returns the new-side content of p in the round when the
// round captured it, and the checked-out file otherwise. Binary files
// are never captured, so they always come from disk. A symlink that
// leaves the repository is treated as missing.
func (s *Server) roundAsset(roundID int64, p string) ([]byte, error) {
	files, err := s.store.FilesForRound(roundID)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		if f.Path != p {
			continue
		}
		if f.Status == store.FileDeleted {
			return nil, os.ErrNotExist
		}
		if f.NewBlob != "" {
			return s.store.Blob(f.NewBlob)
		}
		break
	}
	root, err := filepath.EvalSymlinks(s.repoRoot)
	if err != nil {
		return nil, err
	}
	full, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(p)))
	if err != nil {
		return nil, err
	}
	if full != root && !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return nil, os.ErrNotExist
	}
	info, err := os.Stat(full)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(full)
}
