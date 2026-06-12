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

func TestHardenCompose_InjectsChownSidecarForNamedVolume(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"app": {
				Image:   "ghcr.io/myorg/app",
				Volumes: []string{"uploads:/data/uploads"},
			},
		},
		Volumes: map[string]any{"uploads": nil},
	}

	cfg := minimalConfig()
	cfg.GlobalHardening.DefaultUser = "10001:10002"
	cfg.GlobalHardening.CapDropAll = true
	cfg.GlobalHardening.ReadOnlyRootfs = true

	hardenCompose(compose, cfg, minimalClient("c1"), "p", nil)

	sidecar, ok := compose.Services["app-opsen-chown-init"]
	if !ok {
		t.Fatalf("expected chown init sidecar, services: %v", keys(compose.Services))
	}

	if sidecar.User != "0:0" {
		t.Errorf("expected sidecar user 0:0, got %q", sidecar.User)
	}
	if sidecar.Image != "busybox" {
		t.Errorf("expected default sidecar image busybox, got %q", sidecar.Image)
	}
	if !containsString(sidecar.CapAdd, "CHOWN") {
		t.Errorf("expected sidecar to cap_add CHOWN, got %v", sidecar.CapAdd)
	}
	if len(sidecar.CapDrop) != 1 || sidecar.CapDrop[0] != "ALL" {
		t.Errorf("expected sidecar cap_drop ALL, got %v", sidecar.CapDrop)
	}
	if sidecar.ReadOnly != nil {
		t.Errorf("expected sidecar to NOT inherit read_only rootfs, got %v", *sidecar.ReadOnly)
	}
	if sidecar.Restart != "no" {
		t.Errorf("expected sidecar restart 'no', got %q", sidecar.Restart)
	}

	cmd, ok := sidecar.Command.([]string)
	if !ok {
		t.Fatalf("expected sidecar command []string, got %T", sidecar.Command)
	}
	want := []string{"chown", "-R", "10001:10002", "/data/uploads"}
	if strings.Join(cmd, " ") != strings.Join(want, " ") {
		t.Errorf("expected command %v, got %v", want, cmd)
	}

	if len(sidecar.Volumes) != 1 || sidecar.Volumes[0] != "uploads:/data/uploads" {
		t.Errorf("expected sidecar to mount the named volume rw, got %v", sidecar.Volumes)
	}

	// The app service must wait for the sidecar to complete successfully.
	deps, ok := compose.Services["app"].DependsOn.(map[string]any)
	if !ok {
		t.Fatalf("expected app depends_on map, got %T", compose.Services["app"].DependsOn)
	}
	dep, ok := deps["app-opsen-chown-init"].(map[string]any)
	if !ok {
		t.Fatalf("expected depends_on entry for sidecar, got %v", deps)
	}
	if dep["condition"] != "service_completed_successfully" {
		t.Errorf("expected service_completed_successfully, got %v", dep["condition"])
	}
}

func TestHardenCompose_NoSidecarForBindOrAnonOrReadOnly(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"bind":  {Image: "busybox", User: "1000:1000", Volumes: []string{"/data/host:/data"}},
			"rel":   {Image: "busybox", User: "1000:1000", Volumes: []string{"./local:/data"}},
			"anon":  {Image: "busybox", User: "1000:1000", Volumes: []string{"/data"}},
			"rovol": {Image: "busybox", User: "1000:1000", Volumes: []string{"cache:/data:ro"}},
		},
	}

	hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", nil)

	for _, name := range []string{"bind", "rel", "anon", "rovol"} {
		if _, ok := compose.Services[name+chownSidecarSuffix]; ok {
			t.Errorf("did not expect a chown sidecar for service %q", name)
		}
	}
}

func TestHardenCompose_NoSidecarForRootService(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			// No DefaultUser configured and none declared → service stays root.
			"root": {Image: "busybox", Volumes: []string{"data:/data"}},
			// Explicit root.
			"explicit": {Image: "busybox", User: "0:0", Volumes: []string{"data:/data"}},
		},
	}

	hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", nil)

	if _, ok := compose.Services["root"+chownSidecarSuffix]; ok {
		t.Error("did not expect a chown sidecar for a root service")
	}
	if _, ok := compose.Services["explicit"+chownSidecarSuffix]; ok {
		t.Error("did not expect a chown sidecar for an explicit-root service")
	}
}

func TestHardenCompose_ChownSidecarUsesConfiguredImage(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"app": {Image: "busybox", User: "1000", Volumes: []string{"data:/data"}},
		},
	}

	cfg := minimalConfig()
	cfg.GlobalHardening.ChownInitImage = "registry.internal/util/busybox:1.36"

	hardenCompose(compose, cfg, minimalClient("c1"), "p", nil)

	sidecar := compose.Services["app-opsen-chown-init"]
	if sidecar == nil {
		t.Fatal("expected chown sidecar")
	}
	if sidecar.Image != "registry.internal/util/busybox:1.36" {
		t.Errorf("expected configured init image, got %q", sidecar.Image)
	}
	// Bare uid → chown owner only.
	cmd := sidecar.Command.([]string)
	if cmd[2] != "1000" {
		t.Errorf("expected bare uid '1000' for chown owner, got %q", cmd[2])
	}
}

func TestHardenCompose_ChownSidecarIsIdempotent(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"app": {Image: "busybox", User: "1000:1000", Volumes: []string{"data:/data"}},
		},
	}
	client := minimalClient("c1")

	hardenCompose(compose, minimalConfig(), client, "p", nil)
	first := keys(compose.Services)

	// Re-hardening the already-hardened compose (as the reconciler does) must
	// not stack a second sidecar nor a sidecar-for-the-sidecar.
	hardenCompose(compose, minimalConfig(), client, "p", nil)
	second := keys(compose.Services)

	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("expected exactly app + one sidecar both times, got %v then %v", first, second)
	}
	if _, ok := compose.Services["app-opsen-chown-init-opsen-chown-init"]; ok {
		t.Error("must not generate a sidecar for the sidecar")
	}

	deps := compose.Services["app"].DependsOn.(map[string]any)
	if len(deps) != 1 {
		t.Errorf("expected exactly one depends_on edge after re-harden, got %v", deps)
	}
}

func TestHardenCompose_ChownSidecarPreservesExistingDependsOn(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"app": {
				Image:     "busybox",
				User:      "1000:1000",
				Volumes:   []string{"data:/data"},
				DependsOn: []any{"db"},
			},
			"db": {Image: "postgres"},
		},
	}

	hardenCompose(compose, minimalConfig(), minimalClient("c1"), "p", nil)

	deps := compose.Services["app"].DependsOn.(map[string]any)
	db, ok := deps["db"].(map[string]any)
	if !ok {
		t.Fatalf("expected db dependency preserved as map, got %v", deps["db"])
	}
	if db["condition"] != "service_started" {
		t.Errorf("expected existing short-form dep to become service_started, got %v", db["condition"])
	}
	if _, ok := deps["app-opsen-chown-init"]; !ok {
		t.Errorf("expected sidecar dependency added alongside db, got %v", deps)
	}
}

func TestChownTarget(t *testing.T) {
	tests := []struct {
		user string
		want string
		ok   bool
	}{
		{"", "", false},
		{"0", "", false},
		{"0:0", "", false},
		{"1000", "1000", true},
		{"1000:1000", "1000:1000", true},
		{"10001:20002", "10001:20002", true},
		{"node", "", false},
		{"1000:node", "1000", true},
	}
	for _, tt := range tests {
		got, ok := chownTarget(tt.user)
		if ok != tt.ok || got != tt.want {
			t.Errorf("chownTarget(%q) = (%q, %v), want (%q, %v)", tt.user, got, ok, tt.want, tt.ok)
		}
	}
}

func TestNamedVolumeMounts(t *testing.T) {
	got := namedVolumeMounts([]string{
		"uploads:/data/uploads",
		"/host/path:/data",
		"./local:/data",
		"/anon",
		"cache:/var/cache:ro",
		"shared:/srv:rw",
	})
	if len(got) != 2 {
		t.Fatalf("expected 2 named writable mounts, got %d: %+v", len(got), got)
	}
	if got[0].source != "uploads" || got[0].target != "/data/uploads" {
		t.Errorf("unexpected first mount: %+v", got[0])
	}
	if got[1].source != "shared" || got[1].target != "/srv" {
		t.Errorf("unexpected second mount: %+v", got[1])
	}
}

func keys(m map[string]*ComposeService) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
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
