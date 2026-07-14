package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const cgroupRoot = "/sys/fs/cgroup"

func prepareRuntime() error {
	relative, err := currentCgroupPath()
	if err != nil {
		return err
	}
	service := cgroupAbsolute(relative)
	broker := filepath.Join(service, "broker")
	runs := filepath.Join(service, "runs")
	if err := os.Mkdir(broker, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Mkdir(runs, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.WriteFile(filepath.Join(broker, "cgroup.procs"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(service, "cgroup.subtree_control"), []byte("+memory +pids"), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(runs, "cgroup.subtree_control"), []byte("+memory +pids"), 0o600)
}

type runCgroupHandle struct {
	path   string
	broker string
	pid    int
	before cgroupEvents
}

func enterRunCgroup(runID string, limits runLimits) (*runCgroupHandle, error) {
	name, err := runCgroupName(runID)
	if err != nil {
		return nil, err
	}
	relative, err := currentCgroupPath()
	if err != nil {
		return nil, err
	}
	if filepath.Base(relative) != "broker" {
		return nil, fmt.Errorf("broker cgroup is not prepared")
	}
	service := filepath.Dir(cgroupAbsolute(relative))
	broker := filepath.Join(service, "broker")
	path := filepath.Join(service, "runs", name)
	if err := os.Mkdir(path, 0o755); err != nil {
		return nil, err
	}
	pid, err := globalPID()
	if err != nil {
		os.Remove(path)
		return nil, err
	}
	if err := writeRunCgroup(path, limits, pid); err != nil {
		os.Remove(path)
		return nil, err
	}
	handle := &runCgroupHandle{path: path, broker: broker, pid: pid}
	handle.before, _ = handle.events()
	return handle, nil
}

func (handle *runCgroupHandle) events() (cgroupEvents, error) {
	memory, err := os.ReadFile(filepath.Join(handle.path, "memory.events"))
	if err != nil {
		return cgroupEvents{}, err
	}
	pids, err := os.ReadFile(filepath.Join(handle.path, "pids.events"))
	if err != nil {
		return cgroupEvents{}, err
	}
	return cgroupEvents{
		OOM:     parseCgroupCounter(string(memory), "oom"),
		OOMKill: parseCgroupCounter(string(memory), "oom_kill"),
		PidsMax: parseCgroupCounter(string(pids), "max"),
	}, nil
}

func (handle *runCgroupHandle) cleanup() {
	os.WriteFile(filepath.Join(handle.broker, "cgroup.procs"), []byte(strconv.Itoa(handle.pid)), 0o600)
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		if os.Remove(handle.path) == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func currentCgroupPath() (string, error) {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	return unifiedCgroupPath(string(data))
}

func cgroupAbsolute(relative string) string {
	return filepath.Join(cgroupRoot, strings.TrimPrefix(filepath.Clean(relative), string(filepath.Separator)))
}

func globalPID() (int, error) {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "NSpid:") {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(line, "NSpid:"))
		if len(fields) > 0 {
			return strconv.Atoi(fields[0])
		}
	}
	return 0, fmt.Errorf("global pid is unavailable")
}
