package compose

import (
	"strings"
	"testing"

	"github.com/opsen/agent/internal/config"
)

func minimalConfig() *config.AgentConfig {
	return &config.AgentConfig{
		GlobalHardening: config.GlobalHardening{},
		Deny: config.DenyRules{
			PidMode: "host",
			IpcMode: "host",
		},
	}
}

func minimalClient(name string) *config.ClientPolicy {
	return &config.ClientPolicy{
		Client:  name,
		Compose: &config.ComposePolicy{},
	}
}

func intPtr(v int) *int {
	return &v
}

func hasViolation(violations []string, want string) bool {
	for _, violation := range violations {
		if strings.Contains(violation, want) {
			return true
		}
	}
	return false
}

func TestHardenCompose_NetworkIsProjectScoped(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox"},
		},
	}

	hardenCompose(compose, minimalConfig(), minimalClient("acme"), "shop", nil)

	def, ok := compose.Networks["default"].(map[string]any)
	if !ok {
		t.Fatalf("expected default network as map, got %T", compose.Networks["default"])
	}
	if got := def["name"]; got != "opsen-acme-shop-internal" {
		t.Errorf("expected network name opsen-acme-shop-internal, got %v", got)
	}
	if got := def["internal"]; got != true {
		t.Errorf("expected network internal=true by default, got %v", got)
	}

	// Two projects of the same client must produce distinct networks.
	other := &ComposeFile{
		Services: map[string]*ComposeService{
			"api": {Image: "busybox"},
		},
	}
	hardenCompose(other, minimalConfig(), minimalClient("acme"), "billing", nil)

	otherDef := other.Networks["default"].(map[string]any)
	if def["name"] == otherDef["name"] {
		t.Errorf("expected two projects of the same client to have distinct networks, both got %v", def["name"])
	}
}

func TestHardenCompose_StripsClientPorts(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Ports: []string{"0.0.0.0:80:80", "443:443"}},
		},
	}

	mods := hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", nil)

	if len(compose.Services["web"].Ports) != 0 {
		t.Errorf("expected ports to be stripped, got %v", compose.Services["web"].Ports)
	}

	found := false
	for _, m := range mods {
		if strings.Contains(m, "removed client ports") {
			found = true
		}
	}
	if !found {
		t.Error("expected modification about removed client ports")
	}
}

func TestHardenCompose_InjectsAllocatedPorts(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Expose: []string{"80"}},
			"api": {Expose: []string{"3000"}},
		},
	}

	client := minimalClient("c1")
	client.Compose.Network.IngressBindAddress = "10.0.1.2"

	portMappings := []PortMapping{
		{HostPort: 8000, ContainerPort: "80", Service: "web"},
		{HostPort: 8001, ContainerPort: "3000", Service: "api"},
	}

	hardenCompose(compose, minimalConfig(), client, "p", portMappings)

	// Check web service got its port binding
	webPorts := compose.Services["web"].Ports
	if len(webPorts) != 1 {
		t.Fatalf("expected 1 port for web, got %d", len(webPorts))
	}
	if webPorts[0] != "10.0.1.2:8000:80" {
		t.Errorf("expected 10.0.1.2:8000:80, got %s", webPorts[0])
	}

	// Check api service got its port binding
	apiPorts := compose.Services["api"].Ports
	if len(apiPorts) != 1 {
		t.Fatalf("expected 1 port for api, got %d", len(apiPorts))
	}
	if apiPorts[0] != "10.0.1.2:8001:3000" {
		t.Errorf("expected 10.0.1.2:8001:3000, got %s", apiPorts[0])
	}

	// Expose should be cleared
	if compose.Services["web"].Expose != nil {
		t.Error("expected expose to be cleared on web")
	}
	if compose.Services["api"].Expose != nil {
		t.Error("expected expose to be cleared on api")
	}
}

func TestHardenCompose_PortsReplacedByAllocated(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {
				Ports:  []string{"0.0.0.0:80:80"},
				Expose: []string{"80"},
			},
		},
	}

	client := minimalClient("c1")
	client.Compose.Network.IngressBindAddress = "10.0.1.5"

	portMappings := []PortMapping{
		{HostPort: 8042, ContainerPort: "80", Service: "web"},
	}

	hardenCompose(compose, minimalConfig(), client, "p", portMappings)

	ports := compose.Services["web"].Ports
	if len(ports) != 1 || ports[0] != "10.0.1.5:8042:80" {
		t.Errorf("expected client ports replaced by allocated, got %v", ports)
	}
}

func TestHardenCompose_EmptyBindAddress(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {},
		},
	}

	portMappings := []PortMapping{
		{HostPort: 8000, ContainerPort: "80", Service: "web"},
	}

	hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", portMappings)

	ports := compose.Services["web"].Ports
	if len(ports) != 1 || ports[0] != ":8000:80" {
		t.Errorf("expected :8000:80 with empty bind address, got %v", ports)
	}
}

func TestHardenCompose_NoPortMappings(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"worker": {Image: "busybox"},
		},
	}

	hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", nil)

	if len(compose.Services["worker"].Ports) != 0 {
		t.Errorf("expected no ports on worker, got %v", compose.Services["worker"].Ports)
	}
}

func TestValidateCompose_PidsLimitWithinCap(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox", PidsLimit: intPtr(200)},
		},
	}
	cfg := minimalConfig()
	client := minimalClient("c1")
	client.Compose.PerContainer.MaxPids = 256

	violations := validateCompose(compose, cfg, client.Compose)

	if len(violations) != 0 {
		t.Fatalf("expected no violations, got %v", violations)
	}
}

func TestValidateCompose_PidsLimitOverCap(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox", PidsLimit: intPtr(300)},
		},
	}
	cfg := minimalConfig()
	client := minimalClient("c1")
	client.Compose.PerContainer.MaxPids = 256

	violations := validateCompose(compose, cfg, client.Compose)

	if !hasViolation(violations, "service web: pids limit 300 exceeds per-container max 256") {
		t.Fatalf("expected pids cap violation, got %v", violations)
	}
}

func TestValidateCompose_PidsLimitNonPositive(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox", PidsLimit: intPtr(0)},
		},
	}
	cfg := minimalConfig()
	client := minimalClient("c1")

	violations := validateCompose(compose, cfg, client.Compose)

	if !hasViolation(violations, "service web: pids_limit must be > 0") {
		t.Fatalf("expected non-positive pids violation, got %v", violations)
	}
}

func TestValidateCompose_DefaultPidsOverCap(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox"},
		},
	}
	cfg := minimalConfig()
	client := minimalClient("c1")
	client.Compose.PerContainer.DefaultPids = 300
	client.Compose.PerContainer.MaxPids = 256

	violations := validateCompose(compose, cfg, client.Compose)

	if !hasViolation(violations, "service web: pids limit 300 exceeds per-container max 256") {
		t.Fatalf("expected default pids cap violation, got %v", violations)
	}
}

func TestHardenCompose_PidsLimitPrecedence(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"custom":    {Image: "busybox", PidsLimit: intPtr(128)},
			"defaulted": {Image: "busybox"},
		},
	}
	cfg := minimalConfig()
	cfg.GlobalHardening.PidLimit = 256
	client := minimalClient("c1")
	client.Compose.PerContainer.DefaultPids = 384

	hardenCompose(compose, cfg, client, "p", nil)

	if got := *compose.Services["custom"].PidsLimit; got != 128 {
		t.Errorf("expected service pids_limit to be preserved, got %d", got)
	}
	if got := *compose.Services["defaulted"].PidsLimit; got != 384 {
		t.Errorf("expected default_pids to be applied, got %d", got)
	}
}

func TestHardenCompose_PidsLimitFallsBackToGlobalThenBuiltInDefault(t *testing.T) {
	client := minimalClient("c1")

	globalCompose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox"},
		},
	}
	globalCfg := minimalConfig()
	globalCfg.GlobalHardening.PidLimit = 512

	hardenCompose(globalCompose, globalCfg, client, "p", nil)

	if got := *globalCompose.Services["web"].PidsLimit; got != 512 {
		t.Errorf("expected global pid_limit fallback, got %d", got)
	}

	builtInCompose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Image: "busybox"},
		},
	}

	hardenCompose(builtInCompose, minimalConfig(), client, "p", nil)

	if got := *builtInCompose.Services["web"].PidsLimit; got != config.DefaultPidLimit {
		t.Errorf("expected built-in pids default %d, got %d", config.DefaultPidLimit, got)
	}
}

func TestHardenCompose_TmpfsMerge(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {
				Tmpfs: []string{"/var/cache/nginx"},
			},
		},
	}

	cfg := minimalConfig()
	cfg.GlobalHardening.DefaultTmpfs = []config.TmpfsMount{
		{Path: "/tmp", Options: "noexec,nosuid,size=64m"},
		{Path: "/run", Options: "size=16m"},
	}

	hardenCompose(compose, cfg, minimalClient("c1"), "p", nil)

	tmpfs := parseTmpfsEntries(compose.Services["web"].Tmpfs)
	if len(tmpfs) != 3 {
		t.Fatalf("expected 3 tmpfs entries, got %d: %v", len(tmpfs), tmpfs)
	}

	paths := make(map[string]bool)
	for _, entry := range tmpfs {
		path := strings.SplitN(entry, ":", 2)[0]
		paths[path] = true
	}

	for _, expected := range []string{"/tmp", "/run", "/var/cache/nginx"} {
		if !paths[expected] {
			t.Errorf("missing tmpfs path: %s", expected)
		}
	}
}

func TestHardenCompose_TmpfsDefaultOverridesClient(t *testing.T) {
	// When client specifies /tmp and defaults also specify /tmp,
	// the default should win
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {
				Tmpfs: []string{"/tmp:size=999m"},
			},
		},
	}

	cfg := minimalConfig()
	cfg.GlobalHardening.DefaultTmpfs = []config.TmpfsMount{
		{Path: "/tmp", Options: "noexec,nosuid,size=64m"},
	}

	hardenCompose(compose, cfg, minimalClient("c1"), "p", nil)

	tmpfs := parseTmpfsEntries(compose.Services["web"].Tmpfs)
	if len(tmpfs) != 1 {
		t.Fatalf("expected 1 tmpfs entry (deduped), got %d: %v", len(tmpfs), tmpfs)
	}
	if tmpfs[0] != "/tmp:noexec,nosuid,size=64m" {
		t.Errorf("expected default /tmp options to win, got %s", tmpfs[0])
	}
}

func TestHardenCompose_TmpfsNoDefaults(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {
				Tmpfs: []string{"/var/cache/nginx"},
			},
		},
	}

	// No default tmpfs configured
	hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", nil)

	tmpfs := parseTmpfsEntries(compose.Services["web"].Tmpfs)
	if len(tmpfs) != 1 || tmpfs[0] != "/var/cache/nginx" {
		t.Errorf("expected client tmpfs preserved when no defaults, got %v", tmpfs)
	}
}

func TestHardenCompose_TmpfsStringType(t *testing.T) {
	// Docker Compose accepts tmpfs as a single string
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {
				Tmpfs: "/var/cache",
			},
		},
	}

	cfg := minimalConfig()
	cfg.GlobalHardening.DefaultTmpfs = []config.TmpfsMount{
		{Path: "/tmp"},
	}

	hardenCompose(compose, cfg, minimalClient("c1"), "p", nil)

	tmpfs := parseTmpfsEntries(compose.Services["web"].Tmpfs)
	if len(tmpfs) != 2 {
		t.Fatalf("expected 2 tmpfs entries, got %d: %v", len(tmpfs), tmpfs)
	}
}

func TestParseTmpfsEntries(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  int
	}{
		{"nil", nil, 0},
		{"string", "/tmp", 1},
		{"string slice", []string{"/tmp", "/run"}, 2},
		{"any slice", []any{"/tmp", "/run"}, 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseTmpfsEntries(tt.input)
			if len(got) != tt.want {
				t.Errorf("parseTmpfsEntries(%v) = %d entries, want %d", tt.input, len(got), tt.want)
			}
		})
	}
}
