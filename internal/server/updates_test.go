package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeLatest(t *testing.T, tag string) (*httptest.Server, *int) {
	t.Helper()
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "/releases/tag/"+tag, http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestUpdatesOffersANewerRelease(t *testing.T) {
	srv, hits := fakeLatest(t, "v0.15.0")
	u := newUpdates("v0.14.1")
	u.releases = srv.URL + "/releases"
	if got := u.available(); got != "v0.15.0" {
		t.Fatalf("available() = %q, want v0.15.0", got)
	}
	u.available()
	if *hits != 1 {
		t.Errorf("looked up the latest release %d times, want 1 (cached)", *hits)
	}
}

func TestUpdatesQuietWhenCurrentOrLocal(t *testing.T) {
	srv, hits := fakeLatest(t, "v0.15.0")
	for _, current := range []string{"v0.15.0", "dev", "v0.14.1-3-gb94638c-dirty", ""} {
		u := newUpdates(current)
		u.releases = srv.URL + "/releases"
		if got := u.available(); got != "" {
			t.Errorf("available() on %q = %q, want none", current, got)
		}
	}
	if *hits != 1 {
		t.Errorf("looked up the latest release %d times, want 1 (local builds never look)", *hits)
	}
}
