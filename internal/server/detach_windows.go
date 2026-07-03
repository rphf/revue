//go:build windows

package server

import "syscall"

func detachSysProcAttr() *syscall.SysProcAttr {
	// CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
	return &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x00000008}
}
