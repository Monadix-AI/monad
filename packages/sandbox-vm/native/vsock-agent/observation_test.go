package main

import (
	"strings"
	"testing"
)

func TestClassifyObservedPathHonorsComponentBoundariesAndNoWriteChildren(t *testing.T) {
	policy := observationPolicy{WritableRoots: []string{"/work"}, NoWriteRoots: []string{"/work/readonly"}}

	if got := classifyObservedPath(policy, "openat", "/work/output", 7, "run-1"); got != nil {
		t.Fatalf("allowed write reported: %+v", got)
	}
	for _, target := range []string{"/workspace/output", "/work/readonly/file", "/etc/passwd"} {
		got := classifyObservedPath(policy, "openat", target, 7, "run-1")
		if got == nil || got.Kind != "filesystem" || got.Target != target || got.PID != 7 {
			t.Fatalf("target %q classified as %+v", target, got)
		}
	}
}

func TestClassifyObservedPathNormalizesAbsolutePathsAndDropsUnsafeTargets(t *testing.T) {
	policy := observationPolicy{WritableRoots: []string{"/work"}}
	if got := classifyObservedPath(policy, "renameat2", "/work/../etc/passwd", 8, "run-2"); got == nil || got.Target != "/etc/passwd" {
		t.Fatalf("normalized violation = %+v", got)
	}
	for _, target := range []string{"relative/path", "", "/" + strings.Repeat("界", 1366)} {
		if got := classifyObservedPath(policy, "openat", target, 8, "run-2"); got != nil {
			t.Fatalf("unsafe target %q reported as %+v", target, got)
		}
	}
}

func TestObservationLimiterSuppressesDuplicatesAndEmitsOneLimitRecord(t *testing.T) {
	limiter := newObservationLimiter("run-limit", 2)
	first := violationMessage{Kind: "filesystem", Operation: "openat", RunID: "run-limit", Target: "/a"}
	second := violationMessage{Kind: "filesystem", Operation: "unlinkat", RunID: "run-limit", Target: "/b"}
	third := violationMessage{Kind: "filesystem", Operation: "mkdirat", RunID: "run-limit", Target: "/c"}

	if got := limiter.admit(first); len(got) != 1 || got[0].Target != "/a" {
		t.Fatalf("first = %+v", got)
	}
	if got := limiter.admit(first); len(got) != 0 {
		t.Fatalf("duplicate admitted: %+v", got)
	}
	if got := limiter.admit(second); len(got) != 1 || got[0].Target != "/b" {
		t.Fatalf("second = %+v", got)
	}
	if got := limiter.admit(third); len(got) != 1 || got[0].Operation != "violation-limit" || got[0].Kind != "runtime" {
		t.Fatalf("limit = %+v", got)
	}
	if got := limiter.admit(violationMessage{Kind: "filesystem", Operation: "linkat", Target: "/d"}); len(got) != 0 {
		t.Fatalf("second limit admitted: %+v", got)
	}
}

func TestValidateStartRejectsMalformedObservationRoots(t *testing.T) {
	base := startRequest{
		Version: protocolVersion,
		RunID:   "observe-policy",
		Argv:    []string{"true"},
	}
	for _, policy := range []observationPolicy{
		{WritableRoots: []string{"relative"}},
		{NoWriteRoots: []string{"/" + strings.Repeat("界", 1366)}},
		{WritableRoots: make([]string, 257)},
	} {
		req := base
		req.Observation = policy
		if err := validateStart(req); err == nil || !strings.Contains(err.Error(), "observation policy") {
			t.Fatalf("policy %+v accepted: %v", policy, err)
		}
	}
}
