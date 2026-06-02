package main

import (
	"reflect"
	"testing"
)

func TestApplyMountPolicyPreservesDenyOrder(t *testing.T) {
	var calls []string
	ops := mountOperations{
		denyDirectory: func(target string) error {
			calls = append(calls, "deny-directory:"+target)
			return nil
		},
		denyFile: func(target string) error {
			calls = append(calls, "deny-file:"+target)
			return nil
		},
	}
	policy := mountPolicy{Overlays: []mountOverlay{
		{Kind: "deny-directory", Target: "/work/.ssh"},
		{Kind: "deny-file", Target: "/work/.config"},
	}}

	if err := applyMountPolicy(policy, ops); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"deny-directory:/work/.ssh",
		"deny-file:/work/.config",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestApplyMountPolicyRejectsUnknownAndRelativeOverlays(t *testing.T) {
	ops := mountOperations{
		denyDirectory: func(string) error { return nil },
		denyFile:      func(string) error { return nil },
	}
	for _, overlay := range []mountOverlay{
		{Kind: "unknown", Target: "/work"},
		{Kind: "deny-directory", Target: "relative"},
	} {
		if err := applyMountPolicy(mountPolicy{Overlays: []mountOverlay{overlay}}, ops); err == nil {
			t.Fatalf("overlay was accepted: %+v", overlay)
		}
	}
}
