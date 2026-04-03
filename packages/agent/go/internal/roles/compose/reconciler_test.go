package compose

import (
	"testing"

	"github.com/opsen/agent/internal/config"
)

func TestPolicyHash_StableForSameInput(t *testing.T) {
	cfg := minimalConfig()
	cfg.GlobalHardening.ReadOnlyRootfs = true
	cfg.GlobalHardening.PidLimit = 100
	client := minimalClient("c1")
	client.Compose.Network.IngressBindAddress = "10.0.1.2"

	h1 := policyHash(client, cfg)
	h2 := policyHash(client, cfg)

	if h1 != h2 {
		t.Errorf("expected stable hash, got %s and %s", h1, h2)
	}
}

func TestPolicyHash_ChangesOnBindAddress(t *testing.T) {
	cfg := minimalConfig()
	client := minimalClient("c1")

	client.Compose.Network.IngressBindAddress = "10.0.1.2"
	h1 := policyHash(client, cfg)

	client.Compose.Network.IngressBindAddress = "10.0.1.5"
	h2 := policyHash(client, cfg)

	if h1 == h2 {
		t.Error("expected different hash when bind address changes")
	}
}

func TestPolicyHash_ChangesOnHardening(t *testing.T) {
	cfg := minimalConfig()
	client := minimalClient("c1")

	cfg.GlobalHardening.ReadOnlyRootfs = false
	h1 := policyHash(client, cfg)

	cfg.GlobalHardening.ReadOnlyRootfs = true
	h2 := policyHash(client, cfg)

	if h1 == h2 {
		t.Error("expected different hash when hardening changes")
	}
}

func TestPolicyHash_ChangesOnTmpfs(t *testing.T) {
	cfg := minimalConfig()
	client := minimalClient("c1")

	cfg.GlobalHardening.DefaultTmpfs = []config.TmpfsMount{{Path: "/tmp"}}
	h1 := policyHash(client, cfg)

	cfg.GlobalHardening.DefaultTmpfs = []config.TmpfsMount{{Path: "/tmp"}, {Path: "/run"}}
	h2 := policyHash(client, cfg)

	if h1 == h2 {
		t.Error("expected different hash when tmpfs changes")
	}
}

func TestReconciler_NoRedeployWhenHashMatches(t *testing.T) {
	cfg := minimalConfig()
	client := minimalClient("c1")
	hash := policyHash(client, cfg)

	// Simulate a tracked project with matching hash
	tracker := &ResourceTracker{
		path:    "/dev/null",
		Clients: map[string]*ClientResources{},
		logger:  testLogger(),
	}
	tracker.Clients["c1"] = &ClientResources{
		Projects: map[string]*ProjectResources{
			"myapp": {Containers: 1, PolicyHash: hash},
		},
	}

	// Collect stale projects (same logic as reconcile())
	tracker.mu.RLock()
	var stale []string
	for slug, res := range tracker.Clients["c1"].Projects {
		if res.PolicyHash != policyHash(client, cfg) {
			stale = append(stale, slug)
		}
	}
	tracker.mu.RUnlock()

	if len(stale) != 0 {
		t.Errorf("expected no stale projects when hash matches, got %v", stale)
	}
}

func TestReconciler_DetectsStaleWhenHashDiffers(t *testing.T) {
	cfg := minimalConfig()
	client := minimalClient("c1")
	client.Compose.Network.IngressBindAddress = "10.0.1.2"

	// Project was deployed with old hash
	tracker := &ResourceTracker{
		path:    "/dev/null",
		Clients: map[string]*ClientResources{},
		logger:  testLogger(),
	}
	tracker.Clients["c1"] = &ClientResources{
		Projects: map[string]*ProjectResources{
			"myapp": {Containers: 1, PolicyHash: "old-hash"},
		},
	}

	currentHash := policyHash(client, cfg)

	tracker.mu.RLock()
	var stale []string
	for slug, res := range tracker.Clients["c1"].Projects {
		if res.PolicyHash != currentHash {
			stale = append(stale, slug)
		}
	}
	tracker.mu.RUnlock()

	if len(stale) != 1 || stale[0] != "myapp" {
		t.Errorf("expected myapp as stale, got %v", stale)
	}
}
