//go:build !linux

package main

import "fmt"

func defaultMountOperations() mountOperations {
	unavailable := func(string) error { return fmt.Errorf("mount policy is unavailable") }
	return mountOperations{
		bindReadOnly:  func(string, string) error { return fmt.Errorf("mount policy is unavailable") },
		denyDirectory: unavailable,
		denyFile:      unavailable,
	}
}
