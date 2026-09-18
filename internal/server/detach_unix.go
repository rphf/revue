//go:build unix

package server

import (
	"os"
	"syscall"
)

// detachSysProcAttr detaches the spawned server from the CLI's
// process group and controlling terminal.
func detachSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// terminateProcess asks a detached server to shut down gracefully; the
// server handles SIGTERM like Ctrl-C.
func terminateProcess(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}
