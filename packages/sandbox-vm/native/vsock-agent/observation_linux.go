//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strconv"

	"golang.org/x/sys/unix"
)

const maxObservationRecordBytes = 16 * 1024

var seccompObserverPath = "/usr/local/bin/monad-seccomp-observer"

var observedFilesystemOperations = map[string]struct{}{
	"open": {}, "openat": {}, "openat2": {}, "creat": {}, "truncate": {}, "ftruncate": {},
	"unlink": {}, "unlinkat": {}, "mkdir": {}, "mkdirat": {}, "rmdir": {}, "mknod": {}, "mknodat": {},
	"rename": {}, "renameat": {}, "renameat2": {}, "link": {}, "linkat": {}, "symlink": {}, "symlinkat": {},
}

type rawObservationRecord struct {
	Syscall string `json:"syscall"`
	PID     int    `json:"pid"`
	Path    string `json:"path"`
	Error   string `json:"error"`
}

func prepareObservedCommand(
	cmd *exec.Cmd,
	runID string,
	reporter *supervisorReporter,
) (*exec.Cmd, *os.File, *os.File) {
	if unix.Access(seccompObserverPath, unix.X_OK) != nil {
		reporter.violation("setup", "seccomp-observer", runID, "seccomp observer unavailable")
		return cmd, nil, nil
	}
	eventReader, eventWriter, err := os.Pipe()
	if err != nil {
		reporter.violation("setup", "seccomp-observer", runID, "seccomp observer unavailable")
		return cmd, nil, nil
	}
	eventFD := 3 + len(cmd.ExtraFiles)
	arguments := []string{"--event-fd", strconv.Itoa(eventFD), "--"}
	arguments = append(arguments, cmd.Args...)
	wrapped := exec.Command(seccompObserverPath, arguments...)
	wrapped.Dir = cmd.Dir
	wrapped.Env = append([]string(nil), cmd.Env...)
	wrapped.Stdin = cmd.Stdin
	wrapped.Stdout = cmd.Stdout
	wrapped.Stderr = cmd.Stderr
	wrapped.SysProcAttr = cmd.SysProcAttr
	wrapped.ExtraFiles = append(append([]*os.File(nil), cmd.ExtraFiles...), eventWriter)
	return wrapped, eventReader, eventWriter
}

func drainObservationRecords(
	reader io.Reader,
	policy observationPolicy,
	runID string,
	reporter *supervisorReporter,
) {
	limiter := newObservationLimiter(runID, maxObservationEvents)
	setupEmitted := false
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxObservationRecordBytes)
	for scanner.Scan() {
		var raw rawObservationRecord
		if json.Unmarshal(scanner.Bytes(), &raw) != nil {
			continue
		}
		if raw.Error == "unsupported" {
			if !setupEmitted {
				setupEmitted = true
				reporter.violation("setup", "seccomp-observer", runID, "seccomp observer unsupported")
			}
			continue
		}
		if raw.PID <= 0 {
			continue
		}
		if _, allowed := observedFilesystemOperations[raw.Syscall]; !allowed {
			continue
		}
		violation := classifyObservedPath(policy, raw.Syscall, raw.Path, raw.PID, runID)
		if violation == nil {
			continue
		}
		for _, admitted := range limiter.admit(*violation) {
			reporter.recordViolation(admitted)
		}
	}
}
