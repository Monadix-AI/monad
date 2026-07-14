package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func supervisorCommand(req startRequest) (*exec.Cmd, io.ReadCloser, io.WriteCloser, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, nil, err
	}
	configReader, configWriter, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	resultReader, resultWriter, err := os.Pipe()
	if err != nil {
		configReader.Close()
		configWriter.Close()
		return nil, nil, nil, err
	}
	var controlReader *os.File
	var controlWriter *os.File
	if req.Terminal != nil {
		controlReader, controlWriter, err = os.Pipe()
		if err != nil {
			configReader.Close()
			configWriter.Close()
			resultReader.Close()
			resultWriter.Close()
			return nil, nil, nil, err
		}
	}
	cmd := exec.Command(executable, "--supervise-run")
	cmd.ExtraFiles = []*os.File{configReader, resultWriter}
	if controlReader != nil {
		cmd.ExtraFiles = append(cmd.ExtraFiles, controlReader)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: unix.CLONE_NEWPID | unix.CLONE_NEWNS}
	go func() {
		defer configWriter.Close()
		json.NewEncoder(configWriter).Encode(req)
	}()
	return cmd, resultReader, controlWriter, nil
}

func runSupervisorMode() int {
	config := os.NewFile(3, "run-config")
	if config == nil {
		fmt.Fprintln(os.Stderr, "supervisor: config fd is unavailable")
		return 127
	}
	defer config.Close()
	result := os.NewFile(4, "run-result")
	if result == nil {
		fmt.Fprintln(os.Stderr, "supervisor: result fd is unavailable")
		return 127
	}
	defer result.Close()
	reporter := &supervisorReporter{encoder: json.NewEncoder(result)}
	var req startRequest
	if err := json.NewDecoder(config).Decode(&req); err != nil || validateStart(req) != nil {
		fmt.Fprintln(os.Stderr, "supervisor: invalid config")
		return 127
	}
	var control *os.File
	if req.Terminal != nil {
		control = os.NewFile(5, "run-control")
		if control == nil {
			fmt.Fprintln(os.Stderr, "supervisor: control fd is unavailable")
			return 127
		}
		defer control.Close()
	}
	limits := req.Limits
	if limits.MemoryMiB <= 0 {
		limits.MemoryMiB = 1024
	}
	if limits.MaxProcesses <= 0 {
		limits.MaxProcesses = 256
	}
	group, err := enterRunCgroup(req.RunID, limits)
	if err != nil {
		reporter.violation("setup", "cgroup-init", req.RunID, "cgroup initialization failed")
		fmt.Fprintln(os.Stderr, "supervisor: cgroup:", err)
		return 127
	}
	defer group.cleanup()
	if err := privateTmp(); err != nil {
		reporter.violation("setup", "namespace-init", req.RunID, "mount namespace initialization failed")
		fmt.Fprintln(os.Stderr, "supervisor: private tmp:", err)
		return 127
	}
	cmd, err := workloadCommand(req)
	if err != nil {
		reporter.violation("setup", "runtime-exit", req.RunID, "workload preparation failed")
		fmt.Fprintln(os.Stderr, "supervisor:", err)
		return 127
	}
	var master *os.File
	outputDone := make(chan struct{})
	if req.Terminal != nil {
		master, err = startPTY(cmd, *req.Terminal)
		if err == nil {
			go func() {
				io.Copy(os.Stdout, master)
				close(outputDone)
			}()
			go func() {
				io.Copy(master, os.Stdin)
				master.Close()
			}()
			go applyResizes(control, master)
		}
	} else {
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr.Setpgid = true
		err = cmd.Start()
		close(outputDone)
	}
	if err != nil {
		operation := "runtime-exit"
		if req.Terminal != nil {
			operation = "pty-init"
		}
		reporter.violation("setup", operation, req.RunID, "workload start failed")
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
			if master != nil {
				<-outputDone
				master.Close()
			}
			if after, err := group.events(); err == nil {
				for _, violation := range violationDeltas(req.RunID, group.before, after) {
					reporter.recordViolation(violation)
				}
			}
			if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				sig := int(status.Signal())
				reporter.exit(exitMessage{Code: nil, Signal: sig})
				return 128 + sig
			}
			if waitErr != nil {
				code := cmd.ProcessState.ExitCode()
				reporter.exit(exitMessage{Code: &code})
				return code
			}
			code := 0
			reporter.exit(exitMessage{Code: &code})
			return 0
		}
	}
}

type supervisorReporter struct {
	encoder *json.Encoder
}

func (reporter *supervisorReporter) violation(kind, operation, runID, detail string) {
	reporter.recordViolation(violationMessage{Kind: kind, Operation: operation, RunID: runID, Detail: detail})
}

func (reporter *supervisorReporter) recordViolation(violation violationMessage) {
	reporter.encoder.Encode(supervisorRecord{Type: "violation", Violation: &violation})
}

func (reporter *supervisorReporter) exit(exit exitMessage) {
	reporter.encoder.Encode(supervisorRecord{Type: "exit", Exit: &exit})
}

func applyResizes(control io.Reader, master *os.File) {
	if control == nil || master == nil {
		return
	}
	decoder := json.NewDecoder(control)
	for {
		var req resizeRequest
		if decoder.Decode(&req) != nil {
			return
		}
		if validTerminalSize(req.Cols, req.Rows) {
			resizePTY(master, req)
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
