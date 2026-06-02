//go:build linux || darwin

package main

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

func startPTY(cmd *exec.Cmd, size terminalOptions) (*os.File, error) {
	return pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)})
}

func resizePTY(master *os.File, size resizeRequest) error {
	return pty.Setsize(master, &pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)})
}
