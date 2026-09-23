package server

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// handleRaise brings the browser to the front after a click on a revue
// notification. On macOS, Firefox and its forks select the tab but leave
// the app behind other windows, and a page cannot raise the app itself.
// Only a page on this machine can ask: a browser elsewhere is not ours
// to move.
func (s *Server) handleRaise(w http.ResponseWriter, r *http.Request) {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			if err := s.raise(); err != nil {
				internalError(w, err)
				return
			}
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// raiseDefaultBrowser activates the default browser. It does nothing
// off macOS, where a notification click already raises the window.
func raiseDefaultBrowser() error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	plist := filepath.Join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
	data, err := exec.Command("plutil", "-convert", "json", "-o", "-", plist).Output()
	if err != nil {
		data = nil
	}
	return exec.Command("open", "-b", browserFromHandlers(data)).Run()
}

// browserFromHandlers picks the bundle id that handles https links out
// of the LaunchServices handlers, as plutil prints them in JSON. Safari
// is the default when none is set.
func browserFromHandlers(data []byte) string {
	var prefs struct {
		LSHandlers []struct {
			Scheme string `json:"LSHandlerURLScheme"`
			Role   string `json:"LSHandlerRoleAll"`
		}
	}
	if json.Unmarshal(data, &prefs) == nil {
		for _, scheme := range []string{"https", "http"} {
			for _, h := range prefs.LSHandlers {
				if h.Scheme == scheme && h.Role != "" {
					return h.Role
				}
			}
		}
	}
	return "com.apple.Safari"
}
