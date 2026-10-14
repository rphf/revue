// Package release reads revue's published releases: the latest tag,
// and whether a version is a release build at all.
package release

import (
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// URL is the releases page every lookup starts from.
const URL = "https://github.com/rphf/revue/releases"

var (
	tag = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$`)
	// git describe appends -<commits>-g<sha> past a tag and -dirty on
	// local changes; a release build carries the bare tag.
	describeSuffix = regexp.MustCompile(`-[0-9]+-g[0-9a-f]+(-dirty)?$|-dirty$`)
)

// LocalBuild reports whether v names a build from a checkout rather
// than a published release.
func LocalBuild(v string) bool {
	return !tag.MatchString(v) || describeSuffix.MatchString(v)
}

// Latest reads the tag from the redirect of releases/latest, which
// needs no API token and has no API rate limit.
func Latest(client *http.Client, releases string) (string, error) {
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Get(releases + "/latest")
	if err != nil {
		return "", err
	}
	_ = resp.Body.Close()
	loc := resp.Header.Get("Location")
	if resp.StatusCode/100 != 3 || !strings.Contains(loc, "/tag/") {
		return "", fmt.Errorf("%s/latest answered %s without a release tag", releases, resp.Status)
	}
	t := path.Base(loc)
	if !tag.MatchString(t) {
		return "", fmt.Errorf("unexpected release tag %q", t)
	}
	return t, nil
}

// Newer reports whether release tag a comes after release tag b, by
// their major, minor, and patch numbers.
func Newer(a, b string) bool {
	x, y := core(a), core(b)
	for i := range x {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}

func core(v string) [3]int {
	var n [3]int
	parts := strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3)
	for i, p := range parts {
		if j := strings.IndexAny(p, "-+"); j >= 0 {
			p = p[:j]
		}
		n[i], _ = strconv.Atoi(p)
	}
	return n
}
