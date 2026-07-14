//go:build !linux

package main

import (
	"io"
	"os/exec"
)

func supervisorCommand(req startRequest) (*exec.Cmd, io.ReadCloser, io.ReadWriteCloser, error) {
	cmd, err := workloadCommand(req)
	return cmd, nil, nil, err
}

func runSupervisorMode() int {
	return 127
}
