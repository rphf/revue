package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRelease serves releases/latest and the assets of one tag. The
// binary is a shell script that prints the tag, like `revue version`.
type fakeRelease struct {
	tag       string
	script    string
	checksum  string
	downloads int
}

func newFakeRelease(t *testing.T, tag string) (*fakeRelease, *httptest.Server) {
	t.Helper()
	f := &fakeRelease{tag: tag, script: "#!/bin/sh\necho " + tag + "\n"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asset := fmt.Sprintf("revue_%s_%s.tar.gz", "testos", "testarch")
		archive := tarGz(t, "revue", f.script)
		sum := sha256.Sum256(archive)
		checksum := hex.EncodeToString(sum[:])
		if f.checksum != "" {
			checksum = f.checksum
		}
		switch r.URL.Path {
		case "/latest":
			http.Redirect(w, r, "/tag/"+f.tag, http.StatusFound)
		case "/download/" + f.tag + "/" + asset:
			f.downloads++
			_, _ = w.Write(archive)
		case "/download/" + f.tag + "/checksums.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n%s  other.tar.gz\n", checksum, asset, strings.Repeat("0", 64))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func tarGz(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type updateRun struct {
	code      int
	stdout    string
	stderr    string
	restarted bool
}

func runUpdate(t *testing.T, srv *httptest.Server, exe, current string, args ...string) updateRun {
	t.Helper()
	var stdout, stderr bytes.Buffer
	var r updateRun
	u := &updater{
		releases: srv.URL,
		http:     srv.Client(),
		exe:      exe,
		current:  current,
		goos:     "testos",
		goarch:   "testarch",
		stdout:   &stdout,
		stderr:   &stderr,
		restart: func() (int, error) {
			r.restarted = true
			return 1, nil
		},
	}
	r.code = u.run(args)
	r.stdout, r.stderr = stdout.String(), stderr.String()
	return r
}

func installedBinary(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "revue")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho v0.1.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertOnlyBinary(t *testing.T, exe string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(exe))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temp files left beside the binary: %v", entries)
	}
}

func TestUpdateReplacesBinaryAndRestarts(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	exe := installedBinary(t)

	r := runUpdate(t, srv, exe, "v0.1.0")
	if r.code != ExitOK {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if got := readFile(t, exe); got != f.script {
		t.Fatalf("binary not replaced: %q", got)
	}
	info, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v, want 0755", info.Mode().Perm())
	}
	if !r.restarted {
		t.Fatal("servers not restarted")
	}
	if !strings.Contains(r.stdout, "from v0.1.0 to v0.2.0") {
		t.Fatalf("stdout %q", r.stdout)
	}
	assertOnlyBinary(t, exe)
}

func TestUpdateFollowsSymlink(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	exe := installedBinary(t)
	link := filepath.Join(t.TempDir(), "revue")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}

	if r := runUpdate(t, srv, link, "v0.1.0"); r.code != ExitOK {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if got := readFile(t, exe); got != f.script {
		t.Fatalf("link target not replaced: %q", got)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink replaced by a file: %v %v", fi, err)
	}
}

func TestUpdateChecksumMismatchChangesNothing(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	f.checksum = strings.Repeat("a", 64)
	exe := installedBinary(t)
	before := readFile(t, exe)

	r := runUpdate(t, srv, exe, "v0.1.0")
	if r.code != ExitError || !strings.Contains(r.stderr, "does not match checksums.txt") {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if readFile(t, exe) != before || r.restarted {
		t.Fatal("binary changed or servers restarted after a bad checksum")
	}
	assertOnlyBinary(t, exe)
}

func TestUpdateRejectsBinaryWithWrongVersion(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	f.script = "#!/bin/sh\necho v9.9.9\n"
	exe := installedBinary(t)
	before := readFile(t, exe)

	r := runUpdate(t, srv, exe, "v0.1.0")
	if r.code != ExitError || !strings.Contains(r.stderr, `reports version "v9.9.9"`) {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if readFile(t, exe) != before {
		t.Fatal("binary changed")
	}
	assertOnlyBinary(t, exe)
}

func TestUpdateUnwritableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	_, srv := newFakeRelease(t, "v0.2.0")
	exe := installedBinary(t)
	dir, err := filepath.EvalSymlinks(filepath.Dir(exe))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	r := runUpdate(t, srv, exe, "v0.1.0")
	if r.code != ExitError || !strings.Contains(r.stderr, "cannot write to "+dir) {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
}

func TestUpdateUpToDate(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	exe := installedBinary(t)

	r := runUpdate(t, srv, exe, "v0.2.0")
	if r.code != ExitOK || !strings.Contains(r.stdout, "up to date") {
		t.Fatalf("exit %d: %s%s", r.code, r.stdout, r.stderr)
	}
	if f.downloads != 0 || r.restarted {
		t.Fatal("downloaded or restarted while up to date")
	}
}

func TestUpdateCheckChangesNothing(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	exe := installedBinary(t)

	r := runUpdate(t, srv, exe, "v0.1.0-3-gabc1234-dirty", "--check")
	if r.code != ExitOK || r.stdout != "current v0.1.0-3-gabc1234-dirty, latest v0.2.0\n" {
		t.Fatalf("exit %d: %q %s", r.code, r.stdout, r.stderr)
	}
	if f.downloads != 0 {
		t.Fatal("--check downloaded the archive")
	}
}

func TestUpdateRefusesLocalBuildWithoutForce(t *testing.T) {
	f, srv := newFakeRelease(t, "v0.2.0")
	for _, v := range []string{"dev", "v0.1.0-dirty", "v0.1.0-3-gabc1234", "abc1234"} {
		exe := installedBinary(t)
		r := runUpdate(t, srv, exe, v)
		if r.code != ExitValidation || !strings.Contains(r.stderr, "local build") {
			t.Fatalf("%s: exit %d: %s", v, r.code, r.stderr)
		}
		if f.downloads != 0 {
			t.Fatalf("%s: downloaded a local build's replacement", v)
		}
	}

	exe := installedBinary(t)
	if r := runUpdate(t, srv, exe, "dev", "--force"); r.code != ExitOK {
		t.Fatalf("--force: exit %d: %s", r.code, r.stderr)
	}
	if got := readFile(t, exe); got != f.script {
		t.Fatalf("--force did not replace the binary: %q", got)
	}
}

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
		if got := localBuild(v); got != want {
			t.Errorf("localBuild(%q) = %v, want %v", v, got, want)
		}
	}
}
