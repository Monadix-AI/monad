//go:build !linux && !darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
)

func startPTY(_ *exec.Cmd, _ terminalOptions) (*os.File, error) {
	return nil, fmt.Errorf("pty is unavailable")
}

func resizePTY(_ *os.File, _ resizeRequest) error {
	return fmt.Errorf("pty is unavailable")
}
