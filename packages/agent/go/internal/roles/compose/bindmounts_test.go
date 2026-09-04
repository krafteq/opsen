package compose

import (
	"strings"
	"testing"

	"github.com/opsen/agent/internal/config"
)

// bindMountConfig is minimalConfig with the production default deny list.
func bindMountConfig() *config.AgentConfig {
	cfg := minimalConfig()
	cfg.Deny.HostPaths = []string{"/", "/etc", "/var/run/docker.sock", "/proc", "/sys", "/dev"}
	return cfg
}

func composeWithVolume(t *testing.T, volume string) *ComposeFile {
	t.Helper()
	c, err := parseCompose([]byte("services:\n  web:\n    image: busybox\n    volumes:\n      - " + volume + "\n"))
	if err != nil {
		t.Fatalf("parse compose with volume %q: %v", volume, err)
	}
	return c
}

// expectViolation asserts that violations contains one mentioning want, or —
// for want == "" — that there are none.
func expectViolation(t *testing.T, violations []string, want string) {
	t.Helper()
	if want == "" {
		if len(violations) > 0 {
			t.Fatalf("expected no violations, got %v", violations)
		}
		return
	}
	if !hasViolation(violations, want) {
		t.Fatalf("expected a violation containing %q, got %v", want, violations)
	}
}

// ── Bind-mount source confinement ──────────────────────────

func TestValidateCompose_BindMountSources(t *testing.T) {
	cases := []struct {
		name   string
		volume string
		want   string // substring of the expected violation; "" = allowed
	}{
		// The MappedFile mechanism: read-only mounts below the project directory.
		{"mapped file below the project dir", "./files/web/etc/app.toml:/etc/app.toml:ro", ""},
		{"directory below the project dir", "./files/web/etc:/etc/app:ro", ""},
		{"read-only with extra options", "./files/web/etc:/etc/app:ro,z", ""},
		{"absolute path into the project dir", testProjectDir + "/files/web:/x:ro", ""},
		{"unclean path staying inside the project dir", "./files/../files/web:/x:ro", ""},
		{"named volume", "data:/data", ""},
		{"anonymous volume", "/data", ""},
		{"unrelated host path with an empty allow list", "/data/acme:/data", ""},

		// Rejected in-project shapes.
		{"project dir itself", ".:/x:ro", "project directory itself"},
		{"project dir via traversal", "./files/..:/x:ro", "project directory itself"},
		{"writable in-project mount", "./files/web/data:/data", "must be mounted read-only"},
		{"writable in-project mount, rw flag", "./files/web/data:/data:rw", "must be mounted read-only"},

		// Anything else overlapping the deployments tree.
		{"other client's project, absolute", testDeploymentsDir + "/b/grm/files:/peek:ro", "overlaps the agent deployments directory"},
		{"other client's project, relative", "../../b/grm/files:/peek:ro", "overlaps the agent deployments directory"},
		{"same client's other project", "../other/files:/peek:ro", "overlaps the agent deployments directory"},
		{"client dir", "..:/peek:ro", "overlaps the agent deployments directory"},
		{"deployments dir", "../..:/peek:ro", "overlaps the agent deployments directory"},
		{"agent state file", testDeploymentsDir + "/resource-state.json:/s.json:ro", "overlaps the agent deployments directory"},
		{"ancestor of the deployments dir", "/var/lib/opsen-agent:/x:ro", "overlaps the agent deployments directory"},
		{"sibling of the deployments dir sharing its prefix", "/var/lib/opsen-agent/deployments-old:/x:ro", ""},

		// The deny list sees the resolved path.
		{"denied path", "/etc:/host-etc:ro", "not allowed"},
		{"denied path via traversal", "../../../../../../etc:/host-etc:ro", "not allowed"},
		{"denied path via unclean absolute", "/etc/../etc/passwd:/p:ro", "not allowed"},
		{"denied path with trailing slash", "/etc/:/host-etc:ro", "not allowed"},
		{"denied root", "/:/host:ro", "not allowed"},
		{"denied file", "/var/run/docker.sock:/var/run/docker.sock", "not allowed"},
		{"path merely sharing a denied prefix", "/etcetera:/x", ""},

		// Sources the agent cannot resolve.
		{"interpolated braces", "${PEEK}:/peek:ro", "interpolated"},
		{"interpolated bare", "$PEEK:/peek:ro", "interpolated"},
		{"interpolated suffix", "/data/${X}:/peek:ro", "interpolated"},
		{"home relative", "~/deployments/b/grm/files:/peek:ro", "home-relative"},
		{"home alone", "~:/peek:ro", "home-relative"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			violations := validateCompose(composeWithVolume(t, tc.volume), bindMountConfig(), minimalClient("c1").Compose, testProjectDir)
			expectViolation(t, violations, tc.want)
			if tc.want != "" && !hasViolation(violations, "service web") {
				t.Errorf("violation should name the service, got %v", violations)
			}
		})
	}
}

func TestValidateCompose_TraversalViolationNamesTheResolvedPath(t *testing.T) {
	violations := validateCompose(composeWithVolume(t, "../../../../../../etc:/host-etc:ro"), bindMountConfig(), minimalClient("c1").Compose, testProjectDir)
	if len(violations) != 1 || !strings.Contains(violations[0], "(resolves to '/etc')") {
		t.Fatalf("expected the violation to show the resolved path, got %v", violations)
	}
}

func TestValidateCompose_AllowedHostPathsApplyOutsideTheProject(t *testing.T) {
	client := minimalClient("c1")
	client.Compose.Volumes.AllowedHostPaths = []string{"/data/c1", "/srv/shared/"}

	cases := []struct {
		name   string
		volume string
		want   string
	}{
		{"below an allowed entry", "/data/c1/uploads:/uploads", ""},
		{"the allowed entry itself", "/data/c1:/data", ""},
		{"entry written with a trailing slash", "/srv/shared/x:/x", ""},
		{"sibling sharing the entry's prefix", "/data/c1-old:/data", "not in allowed paths"},
		{"outside", "/srv/other:/srv", "not in allowed paths"},
		{"traversal out of an allowed entry into a denied path", "/data/c1/../../etc:/e:ro", "not allowed"},
		{"traversal out of an allowed entry", "/data/c1/../c2:/e:ro", "not in allowed paths"},
		{"named volume is not a host path", "data:/data", ""},
		{"mapped file needs no allow entry", "./files/web/app.toml:/app.toml:ro", ""},
		{"other project is rejected even if the allow list would cover it", "../../b/grm/files:/peek:ro", "overlaps the agent deployments directory"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			violations := validateCompose(composeWithVolume(t, tc.volume), bindMountConfig(), client.Compose, testProjectDir)
			expectViolation(t, violations, tc.want)
		})
	}
}

func TestValidateCompose_AllowListCoveringTheDeploymentsDirDoesNotUnconfine(t *testing.T) {
	client := minimalClient("c1")
	client.Compose.Volumes.AllowedHostPaths = []string{"/"}
	violations := validateCompose(composeWithVolume(t, testDeploymentsDir+"/b/grm/files:/peek:ro"), bindMountConfig(), client.Compose, testProjectDir)
	expectViolation(t, violations, "overlaps the agent deployments directory")
}

func TestValidateCompose_BindDriverOptsVolumes(t *testing.T) {
	const tmpl = "services:\n  web:\n    image: busybox\n    volumes:\n      - peek:/peek:ro\nvolumes:\n  peek:\n%s"

	cases := []struct {
		name string
		def  string
		want string
	}{
		{"other project via type none + o bind", "    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: " + testDeploymentsDir + "/b/grm/files\n", "overlaps the agent deployments directory"},
		{"denied path via rbind", "    driver_opts:\n      o: rbind\n      device: /etc\n", "not allowed"},
		{"relative device", "    driver_opts:\n      type: none\n      o: bind\n      device: ../../b/grm/files\n", "overlaps the agent deployments directory"},
		{"interpolated device", "    driver_opts:\n      type: none\n      o: bind\n      device: ${PEEK}\n", "interpolated"},
		{"in-project device, writable", "    driver_opts:\n      type: none\n      o: bind\n      device: " + testProjectDir + "/files/web\n", "must be mounted read-only"},
		{"in-project device, read-only", "    driver_opts:\n      type: none\n      o: bind,ro\n      device: " + testProjectDir + "/files/web\n", ""},
		{"nfs export is not a host path", "    driver_opts:\n      type: nfs\n      o: addr=10.0.0.9,rw\n      device: \":/export\"\n", ""},
		{"tmpfs", "    driver_opts:\n      type: tmpfs\n      device: tmpfs\n", ""},
		{"plain named volume", "    {}\n", ""},
		{"external volume", "    external: true\n", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := parseCompose([]byte(strings.Replace(tmpl, "%s", tc.def, 1)))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			violations := validateCompose(c, bindMountConfig(), minimalClient("c1").Compose, testProjectDir)
			expectViolation(t, violations, tc.want)
			if tc.want != "" && !hasViolation(violations, "volume peek") {
				t.Errorf("violation should name the volume, got %v", violations)
			}
		})
	}
}

// A long-syntax volume entry (`type: bind, source: …`) never reaches the
// bind-mount checks: the parser only accepts the short string form, so it
// cannot be used to slip a source past them.
func TestParseCompose_RejectsLongSyntaxVolumes(t *testing.T) {
	_, err := parseCompose([]byte("services:\n  web:\n    image: busybox\n    volumes:\n      - type: bind\n        source: " + testDeploymentsDir + "/b/grm/files\n        target: /peek\n"))
	if err == nil {
		t.Fatal("expected long-syntax volumes to be rejected by the parser")
	}
}

func TestIsBindMountSource(t *testing.T) {
	cases := map[string]bool{
		"data":            false,
		"my_vol-1":        false,
		"":                false,
		"./files":         true,
		"../x":            true,
		".":               true,
		"/data":           true,
		"a/b":             true,
		"~":               true,
		"~/x":             true,
		"$X":              true,
		"${X}":            true,
		"vol${X}":         true,
		"C:\\data":        false, // not a Linux host path; Docker would reject the name
		"/var/run/x.sock": true,
	}
	for source, want := range cases {
		if got := isBindMountSource(source); got != want {
			t.Errorf("isBindMountSource(%q) = %v, want %v", source, got, want)
		}
	}
}

func TestPathWithin(t *testing.T) {
	cases := []struct {
		base, path string
		want       bool
	}{
		{"/a/b", "/a/b", true},
		{"/a/b", "/a/b/c", true},
		{"/a/b", "/a/b/c/d", true},
		{"/a/b", "/a", false},
		{"/a/b", "/a/bc", false},
		{"/a/b", "/a/c", false},
		{"/a/b", "/", false},
		{"/", "/a", true},
		{"/", "/", true},
		{"", "/a", false},
	}
	for _, tc := range cases {
		if got := pathWithin(tc.base, tc.path); got != tc.want {
			t.Errorf("pathWithin(%q, %q) = %v, want %v", tc.base, tc.path, got, tc.want)
		}
	}
}
