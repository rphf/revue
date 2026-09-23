package cli

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/rphf/revue/internal/server"
)

const releasesURL = "https://github.com/rphf/revue/releases"

// maxArchive caps a download, so a wrong URL cannot fill the disk.
const maxArchive = 200 << 20

var (
	releaseTag = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$`)
	// git describe appends -<commits>-g<sha> past a tag and -dirty on
	// local changes; a release build carries the bare tag.
	describeSuffix = regexp.MustCompile(`-[0-9]+-g[0-9a-f]+(-dirty)?$|-dirty$`)
)

// updater replaces the running binary with the latest release. Its
// fields are the seams tests replace.
type updater struct {
	releases string
	http     *http.Client
	exe      string
	current  string
	goos     string
	goarch   string
	stdout   io.Writer
	stderr   io.Writer
	restart  func() (int, error)
}

func cmdUpdate(args []string, stdout, stderr io.Writer) int {
	exe, err := os.Executable()
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot find the revue binary:", err)
		return ExitError
	}
	u := &updater{
		releases: releasesURL,
		http:     &http.Client{Timeout: 2 * time.Minute},
		exe:      exe,
		current:  Version,
		goos:     runtime.GOOS,
		goarch:   runtime.GOARCH,
		stdout:   stdout,
		stderr:   stderr,
		restart:  restartServers,
	}
	return u.run(args)
}

func (u *updater) run(args []string) int {
	fs := newFlagSet("update")
	check := fs.Bool("check", false, "print the current and latest versions, change nothing")
	force := fs.Bool("force", false, "replace a local build, or reinstall the current version")
	if err := fs.Parse(args); err != nil {
		_, _ = fmt.Fprintln(u.stderr, err)
		return ExitValidation
	}
	if fs.NArg() > 0 {
		_, _ = fmt.Fprintf(u.stderr, "revue update takes no arguments, got %q\n", fs.Args())
		return ExitValidation
	}

	latest, err := u.latestTag()
	if err != nil {
		_, _ = fmt.Fprintln(u.stderr, "cannot find the latest release:", err)
		return ExitError
	}
	if *check {
		_, _ = fmt.Fprintf(u.stdout, "current %s, latest %s\n", u.current, latest)
		return ExitOK
	}
	if localBuild(u.current) && !*force {
		_, _ = fmt.Fprintf(u.stderr, "revue %s is a local build; pass --force to replace it with %s\n", u.current, latest)
		return ExitValidation
	}
	if u.current == latest && !*force {
		_, _ = fmt.Fprintf(u.stdout, "revue %s is up to date\n", latest)
		return ExitOK
	}

	target, err := filepath.EvalSymlinks(u.exe)
	if err != nil {
		_, _ = fmt.Fprintln(u.stderr, "cannot resolve the revue binary:", err)
		return ExitError
	}
	if err := u.install(target, latest); err != nil {
		_, _ = fmt.Fprintln(u.stderr, err)
		return ExitError
	}
	_, _ = fmt.Fprintf(u.stdout, "updated %s from %s to %s\n", target, u.current, latest)

	n, err := u.restart()
	if err != nil {
		_, _ = fmt.Fprintln(u.stderr, "the binary is updated, but restarting the servers failed:", err)
		return ExitError
	}
	if n > 0 {
		_, _ = fmt.Fprintf(u.stdout, "restarted %d running server(s) on the new build\n", n)
	}
	return ExitOK
}

func localBuild(v string) bool {
	return !releaseTag.MatchString(v) || describeSuffix.MatchString(v)
}

// latestTag reads the tag from the redirect of releases/latest, which
// needs no API token and has no API rate limit.
func (u *updater) latestTag() (string, error) {
	client := *u.http
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(u.releases + "/latest")
	if err != nil {
		return "", err
	}
	_ = resp.Body.Close()
	loc := resp.Header.Get("Location")
	if resp.StatusCode/100 != 3 || !strings.Contains(loc, "/tag/") {
		return "", fmt.Errorf("%s/latest answered %s without a release tag", u.releases, resp.Status)
	}
	tag := path.Base(loc)
	if !releaseTag.MatchString(tag) {
		return "", fmt.Errorf("unexpected release tag %q", tag)
	}
	return tag, nil
}

// install downloads the release archive, checks it, and renames the
// new binary over target. Any failure leaves target untouched.
func (u *updater) install(target, tag string) error {
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".revue-update-*")
	if err != nil {
		return fmt.Errorf("cannot write to %s (%w); run revue update as the owner of that directory", dir, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	defer func() { _ = tmp.Close() }()

	asset := fmt.Sprintf("revue_%s_%s.tar.gz", u.goos, u.goarch)
	archive, err := u.download(tag, asset)
	if err != nil {
		return err
	}
	sums, err := u.download(tag, "checksums.txt")
	if err != nil {
		return err
	}
	if err := verifyChecksum(archive, sums, asset); err != nil {
		return err
	}
	if err := extractBinary(archive, tmp); err != nil {
		return fmt.Errorf("%s: %w", asset, err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), info.Mode().Perm()|0o100); err != nil {
		return err
	}
	// Run the new binary once before it replaces the old one, so an
	// archive for the wrong platform fails here.
	out, err := exec.Command(tmp.Name(), "version").Output()
	if err != nil {
		return fmt.Errorf("the downloaded binary does not run: %w", err)
	}
	if got := strings.TrimSpace(string(out)); got != tag {
		return fmt.Errorf("the downloaded binary reports version %q, want %q", got, tag)
	}
	// A rename swaps the directory entry in one step; running servers
	// keep the old file open until they restart.
	return os.Rename(tmp.Name(), target)
}

func (u *updater) download(tag, name string) ([]byte, error) {
	url := fmt.Sprintf("%s/download/%s/%s", u.releases, tag, name)
	resp, err := u.http.Get(url)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: %s", url, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxArchive+1))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", url, err)
	}
	if len(data) > maxArchive {
		return nil, fmt.Errorf("download %s: larger than %d MB", url, maxArchive>>20)
	}
	return data, nil
}

// verifyChecksum checks archive against its line in a shasum -a 256
// listing.
func verifyChecksum(archive, sums []byte, asset string) error {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != asset {
			continue
		}
		sum := sha256.Sum256(archive)
		if hex.EncodeToString(sum[:]) != strings.ToLower(fields[0]) {
			return fmt.Errorf("%s does not match checksums.txt", asset)
		}
		return nil
	}
	return fmt.Errorf("checksums.txt has no line for %s", asset)
}

func extractBinary(archive []byte, dst io.Writer) error {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("no revue binary in the archive")
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeReg && path.Clean(hdr.Name) == "revue" {
			_, err := io.Copy(dst, io.LimitReader(tr, maxArchive))
			return err
		}
	}
}

// restartServers replaces every running server with one on the new
// binary, on the same port with the same token. A server that did not
// record its repository is only stopped; the next command revives it.
func restartServers() (int, error) {
	running, err := server.Running()
	if err != nil {
		return 0, err
	}
	var errs []error
	for _, st := range running {
		if st.Repo == "" {
			errs = append(errs, server.Stop(st))
			continue
		}
		_, err := server.Ensure(st.Repo)
		errs = append(errs, err)
	}
	return len(running), errors.Join(errs...)
}
