//go:build !linux

package main

import "os/exec"

func supervisorCommand(req startRequest) (*exec.Cmd, error) {
	return workloadCommand(req)
}

func runSupervisorMode() int {
	return 127
}
