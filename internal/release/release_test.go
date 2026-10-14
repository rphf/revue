package release

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalBuild(t *testing.T) {
	for v, want := range map[string]bool{
		"v0.8.0":             false,
		"v1.0.0-rc.1":        false,
		"v0.8.0-2-g1a2b3c4":  true,
		"v0.8.0-dirty":       true,
		"v1.0.0-rc.1-dirty":  true,
		"dev":                true,
		"61b5986":            true,
		"61b5986-dirty":      true,
		"v0.8.0-12-gdeadbee": true,
	} {
		if got := LocalBuild(v); got != want {
			t.Errorf("LocalBuild(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"v0.15.0", "v0.14.1", true},
		{"v0.14.1", "v0.14.1", false},
		{"v0.14.1", "v0.15.0", false},
		{"v1.0.0", "v0.99.99", true},
		{"v0.10.0", "v0.9.0", true},
		{"v1.0.0", "v1.0.0-rc.1", false},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestLatest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/releases/tag/v0.15.0", http.StatusFound)
	}))
	defer srv.Close()
	got, err := Latest(srv.Client(), srv.URL+"/releases")
	if err != nil || got != "v0.15.0" {
		t.Fatalf("Latest = %q, %v; want v0.15.0", got, err)
	}
}
