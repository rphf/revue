//go:build windows

package server

import (
	"os"
	"syscall"
)

func detachSysProcAttr() *syscall.SysProcAttr {
	// CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
	return &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x00000008}
}

// terminateProcess: Windows has no SIGTERM for other processes.
func terminateProcess(p *os.Process) error {
	return p.Kill()
}
