package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestReadFrameRejectsOversizedControlBeforeBodyRead(t *testing.T) {
	header := []byte{frameStart, 0x00, 0x10, 0x00, 0x01}
	_, err := readFrame(bytes.NewReader(header))
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected bounded-frame error, got %v", err)
	}
}

func TestManagedCommandPrefersStructuredSupervisorExit(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", `printf '{"code":null,"signal":15}' >&3; exit 143`)
	cmd.ExtraFiles = []*os.File{writer}
	run, err := startManagedCommand(cmd, reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	result := <-run.done
	if result.Code != nil || result.Signal != 15 {
		t.Fatalf("expected signal metadata, got %+v", result)
	}
}

func TestManagedRunTerminateStopsProcessGroup(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 60 & wait")
	run, err := startCommand(cmd, nil)
	if err != nil {
		t.Fatal(err)
	}

	run.terminate(50 * time.Millisecond)
	select {
	case result := <-run.done:
		if result.Signal == 0 {
			t.Fatalf("expected signal exit, got %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("process group survived termination")
	}
}

func TestHandleControlRejectsUnknownFrames(t *testing.T) {
	err := handleControl(&managedRun{}, &frameWriter{w: &bytes.Buffer{}}, wireFrame{Kind: 99})
	if err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("expected unsupported-frame error, got %v", err)
	}
}

func TestRunRegistryCancelAllTerminatesActiveRuns(t *testing.T) {
	registry := newRunRegistry()
	run, err := startCommand(exec.Command("sh", "-c", "sleep 60 & wait"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.add("active", run); err != nil {
		t.Fatal(err)
	}

	registry.cancelAll(50 * time.Millisecond)

	select {
	case <-run.finished:
	case <-time.After(3 * time.Second):
		t.Fatal("active run survived registry shutdown")
	}
}
