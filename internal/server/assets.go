package server

import (
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/rphf/revue/internal/gitx"
)

// Image types the rich markdown view may embed and the diff previews.
// Anything else is refused, so these stay image endpoints rather than a
// file server.
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

// handleAsset serves an image that a markdown file references, for the
// rich view, from the repository on disk: what the reviewer has checked
// out, which is also what the live diff shows. The response can never
// act as a page: SVG may carry script, so it is sandboxed and never
// sniffed.
func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
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
	content, err := repoAsset(s.repoRoot, p)
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, "not_found", "no such file in the repository")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeImage(w, ctype, content)
}

// handleDiffImage serves one side of an image file in a diff, from the
// diff itself rather than the checkout, so the old side and the files
// of a commit range show too.
func (s *Server) handleDiffImage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	side := q.Get("side")
	if side != "old" && side != "new" {
		httpError(w, http.StatusBadRequest, "validation", "side must be old or new")
		return
	}
	p := q.Get("path")
	ctype, ok := assetTypes[strings.ToLower(path.Ext(p))]
	if !ok {
		httpError(w, http.StatusUnsupportedMediaType, "unsupported_type", "only image files are served")
		return
	}
	c, ok := s.captureFromQuery(w, queryArgs(r))
	if !ok {
		return
	}
	f := c.files[p]
	if f == nil {
		httpError(w, http.StatusNotFound, "not_found", "no such file in this diff")
		return
	}
	content, err := gitx.ReadSide(s.repoRoot, f, side == "old")
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, http.StatusNotFound, "not_found", "this side of the file does not exist")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeImage(w, ctype, content)
}

// writeImage sends image bytes that can never act as a page: SVG may
// carry script, so the response is sandboxed and never sniffed.
func writeImage(w http.ResponseWriter, ctype string, content []byte) {
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "no-cache")
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

// repoAsset reads the checked-out file at p. A symlink that leaves the
// repository is treated as missing.
func repoAsset(repoRoot, p string) ([]byte, error) {
	root, err := filepath.EvalSymlinks(repoRoot)
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
