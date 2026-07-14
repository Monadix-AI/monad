package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const (
	protocolVersion      = 3
	maxControlFrameBytes = 1024 * 1024
	maxStreamFrameBytes  = 64 * 1024

	frameStart      byte = 1
	frameStdin      byte = 2
	frameCloseStdin byte = 3
	frameSignal     byte = 4
	frameResize     byte = 5

	frameStarted     byte = 16
	frameStdout      byte = 17
	frameStderr      byte = 18
	frameError       byte = 19
	frameExit        byte = 20
	frameUnsupported byte = 21
	frameViolation   byte = 22
)

type wireFrame struct {
	Kind    byte
	Payload []byte
}

type runLimits struct {
	MemoryMiB        int `json:"memoryMiB,omitempty"`
	MaxProcesses     int `json:"maxProcesses,omitempty"`
	TerminateGraceMs int `json:"terminateGraceMs,omitempty"`
}

type startRequest struct {
	Version  int               `json:"version"`
	RunID    string            `json:"runId"`
	Argv     []string          `json:"argv"`
	Cwd      string            `json:"cwd,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	Limits   runLimits         `json:"limits,omitempty"`
	Terminal *terminalOptions  `json:"terminal,omitempty"`
}

type terminalOptions struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type resizeRequest struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type signalRequest struct {
	Signal int `json:"signal"`
}

type startedMessage struct {
	RunID string `json:"runId"`
	PID   int    `json:"pid"`
}

type exitMessage struct {
	Code   *int `json:"code"`
	Signal int  `json:"signal"`
}

type violationMessage struct {
	Kind      string `json:"kind"`
	Operation string `json:"operation"`
	RunID     string `json:"runId"`
	Target    string `json:"target,omitempty"`
	PID       int    `json:"pid,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

type supervisorRecord struct {
	Type      string            `json:"type"`
	Violation *violationMessage `json:"violation,omitempty"`
	Exit      *exitMessage      `json:"exit,omitempty"`
}

func frameLimit(kind byte) uint32 {
	if kind == frameStdin || kind == frameStdout || kind == frameStderr {
		return maxStreamFrameBytes
	}
	return maxControlFrameBytes
}

func readFrame(r io.Reader) (wireFrame, error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return wireFrame{}, err
	}
	length := binary.BigEndian.Uint32(header[1:])
	if length > frameLimit(header[0]) {
		return wireFrame{}, fmt.Errorf("vsock protocol: frame exceeds %d bytes", frameLimit(header[0]))
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return wireFrame{}, err
	}
	return wireFrame{Kind: header[0], Payload: payload}, nil
}

type frameWriter struct {
	w  io.Writer
	mu sync.Mutex
}

func (w *frameWriter) write(kind byte, payload []byte) error {
	if uint32(len(payload)) > frameLimit(kind) {
		return fmt.Errorf("vsock protocol: frame exceeds %d bytes", frameLimit(kind))
	}
	var header [5]byte
	header[0] = kind
	binary.BigEndian.PutUint32(header[1:], uint32(len(payload)))
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.w.Write(header[:]); err != nil {
		return err
	}
	_, err := w.w.Write(payload)
	return err
}

func (w *frameWriter) json(kind byte, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return w.write(kind, payload)
}
