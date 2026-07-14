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
