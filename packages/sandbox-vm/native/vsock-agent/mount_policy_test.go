package main

import (
	"reflect"
	"testing"
)

func TestApplyMountPolicyPreservesOverlayOrder(t *testing.T) {
	var calls []string
	ops := mountOperations{
		bindReadOnly: func(source, target string) error {
			calls = append(calls, "bind:"+source+":"+target)
			return nil
		},
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
		{Kind: "protect-store", Source: "/run/monad/masks/0", Target: "/tmp/masks"},
		{Kind: "deny-directory", Target: "/work/.ssh"},
		{Kind: "deny-file", Target: "/work/.config"},
		{Kind: "mask-file", Source: "/run/monad/masks/0/token", Target: "/work/token"},
	}}

	if err := applyMountPolicy(policy, ops); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"bind:/run/monad/masks/0:/tmp/masks",
		"deny-directory:/work/.ssh",
		"deny-file:/work/.config",
		"bind:/run/monad/masks/0/token:/work/token",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestApplyMountPolicyRejectsUnknownAndRelativeOverlays(t *testing.T) {
	ops := mountOperations{
		bindReadOnly:  func(string, string) error { return nil },
		denyDirectory: func(string) error { return nil },
		denyFile:      func(string) error { return nil },
	}
	for _, overlay := range []mountOverlay{
		{Kind: "unknown", Target: "/work"},
		{Kind: "deny-directory", Target: "relative"},
		{Kind: "mask-file", Source: "relative", Target: "/work/token"},
	} {
		if err := applyMountPolicy(mountPolicy{Overlays: []mountOverlay{overlay}}, ops); err == nil {
			t.Fatalf("overlay was accepted: %+v", overlay)
		}
	}
}
