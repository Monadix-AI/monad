package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func supervisorCommand(req startRequest) (*exec.Cmd, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(executable, "--supervise-run")
	cmd.ExtraFiles = []*os.File{reader}
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: unix.CLONE_NEWPID | unix.CLONE_NEWNS}
	go func() {
		defer writer.Close()
		json.NewEncoder(writer).Encode(req)
	}()
	return cmd, nil
}

func runSupervisorMode() int {
	config := os.NewFile(3, "run-config")
	if config == nil {
		fmt.Fprintln(os.Stderr, "supervisor: config fd is unavailable")
		return 127
	}
	defer config.Close()
	var req startRequest
	if err := json.NewDecoder(config).Decode(&req); err != nil || validateStart(req) != nil {
		fmt.Fprintln(os.Stderr, "supervisor: invalid config")
		return 127
	}
	limits := req.Limits
	if limits.MemoryMiB <= 0 {
		limits.MemoryMiB = 1024
	}
	if limits.MaxProcesses <= 0 {
		limits.MaxProcesses = 256
	}
	cleanup, err := enterRunCgroup(req.RunID, limits)
	if err != nil {
		fmt.Fprintln(os.Stderr, "supervisor: cgroup:", err)
		return 127
	}
	defer cleanup()
	if err := privateTmp(); err != nil {
		fmt.Fprintln(os.Stderr, "supervisor: private tmp:", err)
		return 127
	}
	cmd, err := workloadCommand(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "supervisor:", err)
		return 127
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr.Setpgid = true
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "supervisor: start:", err)
		return 127
	}
	signals := make(chan os.Signal, 8)
	signal.Notify(signals)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var waitErr error
	for {
		select {
		case sig := <-signals:
			if value, ok := sig.(syscall.Signal); ok {
				syscall.Kill(-cmd.Process.Pid, value)
			}
		case waitErr = <-done:
			signal.Stop(signals)
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			reapChildren()
			if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				return 128 + int(status.Signal())
			}
			if waitErr != nil {
				return cmd.ProcessState.ExitCode()
			}
			return 0
		}
	}
}

func privateTmp() error {
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return err
	}
	if err := os.MkdirAll("/tmp", 0o1777); err != nil {
		return err
	}
	return unix.Mount("tmpfs", "/tmp", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=1777,size=256m")
}

func reapChildren() {
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		var status syscall.WaitStatus
		pid, _ := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid <= 0 {
			time.Sleep(10 * time.Millisecond)
			continue
		}
	}
}
