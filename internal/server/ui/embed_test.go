package ui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A file under assets/ is named after its content, so the browser may
// keep it; the page that names those files is checked on every load.
func TestHandlerCacheHeaders(t *testing.T) {
	h := Handler()
	get := func(p string) string {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", p, rec.Code)
		}
		return rec.Header().Get("Cache-Control")
	}

	for _, p := range []string{"/", "/some/client/route"} {
		if got := get(p); got != "no-cache" {
			t.Errorf("GET %s: Cache-Control %q, want no-cache", p, got)
		}
	}

	assets, err := fs.Glob(dist, "dist/assets/*")
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) == 0 {
		t.Skip("placeholder build: no assets to serve")
	}
	p := "/" + strings.TrimPrefix(assets[0], "dist/")
	if got := get(p); !strings.Contains(got, "immutable") {
		t.Errorf("GET %s: Cache-Control %q, want immutable", p, got)
	}
}
