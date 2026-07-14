package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func runCgroupName(runID string) (string, error) {
	if !safeRunID.MatchString(runID) {
		return "", fmt.Errorf("invalid run id")
	}
	return "run-" + runID, nil
}

func writeRunCgroup(path string, limits runLimits, pid int) error {
	if limits.MemoryMiB > 0 {
		bytes := int64(limits.MemoryMiB) * 1024 * 1024
		if err := os.WriteFile(filepath.Join(path, "memory.max"), []byte(strconv.FormatInt(bytes, 10)), 0o600); err != nil {
			return err
		}
	}
	if limits.MaxProcesses > 0 {
		if err := os.WriteFile(filepath.Join(path, "pids.max"), []byte(strconv.Itoa(limits.MaxProcesses)), 0o600); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(path, "cgroup.procs"), []byte(strconv.Itoa(pid)), 0o600)
}

func unifiedCgroupPath(data string) (string, error) {
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "0::") {
			path := strings.TrimPrefix(line, "0::")
			if path != "" {
				return path, nil
			}
		}
	}
	return "", fmt.Errorf("cgroup v2 is unavailable")
}

type cgroupEvents struct {
	OOM     uint64
	OOMKill uint64
	PidsMax uint64
}

func parseCgroupCounter(data, name string) uint64 {
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != name {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			return value
		}
	}
	return 0
}

func violationDeltas(runID string, before, after cgroupEvents) []violationMessage {
	violations := make([]violationMessage, 0, 3)
	if after.OOM > before.OOM {
		delta := after.OOM - before.OOM
		violations = append(violations, violationMessage{
			Kind: "memory", Operation: "oom", RunID: runID,
			Detail: fmt.Sprintf("memory.events oom increased by %d", delta),
		})
	}
	if after.OOMKill > before.OOMKill {
		delta := after.OOMKill - before.OOMKill
		violations = append(violations, violationMessage{
			Kind: "memory", Operation: "oom-kill", RunID: runID,
			Detail: fmt.Sprintf("memory.events oom_kill increased by %d", delta),
		})
	}
	if after.PidsMax > before.PidsMax {
		delta := after.PidsMax - before.PidsMax
		violations = append(violations, violationMessage{
			Kind: "process-limit", Operation: "pids-max", RunID: runID,
			Detail: fmt.Sprintf("pids.events max increased by %d", delta),
		})
	}
	return violations
}
