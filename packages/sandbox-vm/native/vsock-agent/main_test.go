package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestReadFrameRejectsOversizedControlBeforeBodyRead(t *testing.T) {
	header := []byte{frameStart, 0x00, 0x10, 0x00, 0x01}
	_, err := readFrame(bytes.NewReader(header))
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected bounded-frame error, got %v", err)
	}
}

func TestAuthorizeVsockPeerAllowsOnlyHostCID(t *testing.T) {
	if !authorizeVsockPeer(&unix.SockaddrVM{CID: unix.VMADDR_CID_HOST}) {
		t.Fatal("host CID was rejected")
	}
	if authorizeVsockPeer(&unix.SockaddrVM{CID: 3}) {
		t.Fatal("guest-local CID was accepted")
	}
	if authorizeVsockPeer(&unix.SockaddrUnix{Name: "/tmp/not-vsock"}) {
		t.Fatal("non-vsock peer was accepted")
	}
}

func TestManagedCommandPrefersStructuredSupervisorExit(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", `printf '{"type":"exit","exit":{"code":null,"signal":15}}\n' >&3; exit 143`)
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

func TestManagedCommandForwardsSupervisorViolationsBeforeExit(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", `printf '%s\n' '{"type":"violation","violation":{"kind":"memory","operation":"oom-kill","runId":"run-1"}}' '{"type":"exit","exit":{"code":137,"signal":0}}' >&3; exit 137`)
	cmd.ExtraFiles = []*os.File{writer}
	var frames []wireFrame
	run, err := startManagedCommand(cmd, reader, func(kind byte, data []byte) {
		frames = append(frames, wireFrame{Kind: kind, Payload: append([]byte(nil), data...)})
	})
	if err != nil {
		t.Fatal(err)
	}
	result := <-run.done
	if result.Code == nil || *result.Code != 137 {
		t.Fatalf("exit = %+v", result)
	}
	if len(frames) != 1 || frames[0].Kind != frameViolation {
		t.Fatalf("frames = %#v", frames)
	}
	var violation violationMessage
	if err := json.Unmarshal(frames[0].Payload, &violation); err != nil {
		t.Fatal(err)
	}
	if violation.Operation != "oom-kill" || violation.RunID != "run-1" {
		t.Fatalf("violation = %+v", violation)
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
	var output bytes.Buffer
	err := handleControl(&managedRun{}, &frameWriter{w: &output}, wireFrame{Kind: 99})
	if err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("expected unsupported-frame error, got %v", err)
	}
	frame, readErr := readFrame(&output)
	if readErr != nil || frame.Kind != frameViolation {
		t.Fatalf("violation frame = %+v, %v", frame, readErr)
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

func TestBaselineStateIsPreWorkloadAndIrreversible(t *testing.T) {
	registry := newRunRegistry()
	ready, err := registry.prepareBaseline(registry.agentDigest)
	if err != nil || !ready.CaptureEligible || ready.EverStarted || ready.ActiveRuns != 0 {
		t.Fatalf("prepare baseline failed: ready=%+v err=%v", ready, err)
	}
	if _, err := registry.restoredBaseline(ready.BootEpoch, ready.AgentDigest); err != nil {
		t.Fatalf("restored baseline failed: %v", err)
	}
	run := &managedRun{}
	if err := registry.add("first", run); err != nil {
		t.Fatalf("first workload rejected: %v", err)
	}
	registry.remove("first", run)
	if _, err := registry.prepareBaseline(registry.agentDigest); err == nil {
		t.Fatal("baseline capture accepted after a workload started")
	}
}

func TestBaselineRejectsDigestAndEpochMismatch(t *testing.T) {
	registry := newRunRegistry()
	if _, err := registry.prepareBaseline("wrong"); err == nil {
		t.Fatal("wrong guest digest accepted")
	}
	ready, err := registry.prepareBaseline(registry.agentDigest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.restoredBaseline("wrong", ready.AgentDigest); err == nil {
		t.Fatal("wrong boot epoch accepted")
	}
}

func TestBaselineRejectsReservedWorkloadBeforeProcessLaunch(t *testing.T) {
	registry := newRunRegistry()
	if err := registry.admit("reserved"); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.prepareBaseline(registry.agentDigest); err == nil {
		t.Fatal("baseline accepted while a workload start was reserved")
	}
}
