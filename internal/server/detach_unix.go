//go:build unix

package server

import "syscall"

// detachSysProcAttr detaches the spawned server from the CLI's
// process group and controlling terminal.
func detachSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
