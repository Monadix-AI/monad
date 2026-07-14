package main

import (
	"bytes"
	"encoding/json"
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

func TestValidateStartRejectsInvalidTerminalDimensions(t *testing.T) {
	base := startRequest{Version: protocolVersion, RunID: "pty-size", Argv: []string{"sh"}}
	for _, terminal := range []terminalOptions{{Cols: 0, Rows: 24}, {Cols: 80, Rows: 1001}} {
		req := base
		req.Terminal = &terminal
		if err := validateStart(req); err == nil || !strings.Contains(err.Error(), "terminal dimensions") {
			t.Fatalf("expected dimension error for %+v, got %v", terminal, err)
		}
	}
}

func TestHandleControlForwardsValidatedTerminalResize(t *testing.T) {
	var got resizeRequest
	run := &managedRun{resize: func(req resizeRequest) error {
		got = req
		return nil
	}}
	payload, err := json.Marshal(resizeRequest{Cols: 120, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}
	if err := handleControl(run, &frameWriter{w: &bytes.Buffer{}}, wireFrame{Kind: frameResize, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if got.Cols != 120 || got.Rows != 40 {
		t.Fatalf("resize = %+v", got)
	}
	bad, err := json.Marshal(resizeRequest{Cols: 0, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}
	if err := handleControl(run, &frameWriter{w: &bytes.Buffer{}}, wireFrame{Kind: frameResize, Payload: bad}); err == nil {
		t.Fatal("invalid resize was accepted")
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
