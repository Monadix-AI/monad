//go:build linux

package main

import (
	"errors"
	"syscall"
	"testing"
)

func TestReapingFinishesWhenNoChildrenRemain(t *testing.T) {
	if !shouldFinishReaping(-1, syscall.ECHILD) {
		t.Fatal("ECHILD did not finish reaping")
	}
	if !shouldFinishReaping(-1, errors.Join(errors.New("wait"), syscall.ECHILD)) {
		t.Fatal("wrapped ECHILD did not finish reaping")
	}
	if shouldFinishReaping(0, nil) || shouldFinishReaping(1, nil) {
		t.Fatal("live or pending children finished reaping")
	}
}
