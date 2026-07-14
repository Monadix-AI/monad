package main

import (
	"bytes"
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
