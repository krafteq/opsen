package compose

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

// fakeComposeBinary returns the path of a stand-in for `docker compose` that
// accepts any arguments and exits 0, so handler tests exercise everything up to
// (but not including) the real compose invocation.
func fakeComposeBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake compose binary: %v", err)
	}
	return path
}

// testHandler builds a compose Handler with hardening enabled (non-root user,
// cap_drop ALL, read-only rootfs) whose deployments dir lives in a temp dir.
func testHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	deploymentsDir := filepath.Join(t.TempDir(), "deployments")
	cfg := minimalConfig()
	cfg.Roles.Compose = &config.ComposeRoleConfig{
		ComposeBinary:  fakeComposeBinary(t),
		DeploymentsDir: deploymentsDir,
	}
	cfg.GlobalHardening = config.GlobalHardening{
		NoNewPrivileges: true,
		CapDropAll:      true,
		ReadOnlyRootfs:  true,
		DefaultUser:     "1000:1000",
	}
	clientStore, err := config.NewClientStore(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("NewClientStore: %v", err)
	}
	return NewHandler(cfg, clientStore, testLogger()), deploymentsDir
}

func deployProject(t *testing.T, h *Handler, client *config.ClientPolicy, project string, files map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(DeployRequest{Files: files})
	if err != nil {
		t.Fatalf("marshal deploy request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPut, "/v1/compose/projects/"+project, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(identity.WithClient(req.Context(), client))

	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/compose/projects/{project}", h.Deploy)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Errorf("%s: expected mode %04o, got %04o", path, want, got)
	}
}

func mkdirWithMode(t *testing.T, dir string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(dir, mode); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.Chmod(dir, mode); err != nil {
		t.Fatalf("chmod %s: %v", dir, err)
	}
}

func writeWithMode(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod %s: %v", path, err)
	}
}

// mappedFileCompose is the shape app-platform emits for a MappedFile: the
// content lands under files/<process>/<path> and is bind-mounted read-only.
const mappedFileCompose = `services:
  web:
    image: busybox
    volumes:
      - ./files/web/etc/grm/config.toml.tmpl:/etc/grm/config.toml.tmpl:ro
`

// ── Project file modes ─────────────────────────────────────

func TestDeploy_MappedFilesAreReadableByContainerUser(t *testing.T) {
	h, deploymentsDir := testHandler(t)
	client := minimalClient("acme")

	rr := deployProject(t, h, client, "grm", map[string]string{
		"compose.yml":                        mappedFileCompose,
		"files/web/etc/grm/config.toml.tmpl": "[grm]\nname = \"x\"\n",
		".env":                               "DB_HOST=10.0.0.5\n",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	projectDir := filepath.Join(deploymentsDir, "acme", "grm")

	// The tree above the project files stays agent-private.
	assertMode(t, filepath.Join(deploymentsDir, "acme"), 0o750)
	assertMode(t, projectDir, 0o750)
	// The compose file carries env secrets and is never bind-mounted.
	assertMode(t, filepath.Join(projectDir, "compose.yml"), 0o640)
	// Everything that can be bind-mounted must be readable/searchable by the
	// hardened service's (unrelated, non-root) uid.
	for _, dir := range []string{"files", "files/web", "files/web/etc", "files/web/etc/grm"} {
		assertMode(t, filepath.Join(projectDir, dir), 0o755)
	}
	assertMode(t, filepath.Join(projectDir, "files/web/etc/grm/config.toml.tmpl"), 0o644)
	assertMode(t, filepath.Join(projectDir, ".env"), 0o644)

	// Content is written verbatim; only the compose file is rewritten (hardened).
	mapped, err := os.ReadFile(filepath.Join(projectDir, "files/web/etc/grm/config.toml.tmpl"))
	if err != nil {
		t.Fatalf("read mapped file: %v", err)
	}
	if string(mapped) != "[grm]\nname = \"x\"\n" {
		t.Errorf("mapped file content changed: %q", mapped)
	}
	composeOut, err := os.ReadFile(filepath.Join(projectDir, "compose.yml"))
	if err != nil {
		t.Fatalf("read compose file: %v", err)
	}
	if !strings.Contains(string(composeOut), "user: 1000:1000") {
		t.Errorf("expected hardened compose file with injected user, got:\n%s", composeOut)
	}
}

func TestDeploy_RepairsModesOfPreviouslyDeployedProject(t *testing.T) {
	h, deploymentsDir := testHandler(t)
	client := minimalClient("acme")

	// Lay the tree down the way agent versions before OPSEN-6 did: 0750
	// directories all the way down and 0640 files — unreadable for a hardened
	// service. os.WriteFile / os.MkdirAll alone would leave these modes as-is.
	projectDir := filepath.Join(deploymentsDir, "acme", "grm")
	for _, dir := range []string{"", "files", "files/web", "files/web/etc", "files/web/etc/grm"} {
		mkdirWithMode(t, filepath.Join(projectDir, dir), 0o750)
	}
	mapped := filepath.Join(projectDir, "files/web/etc/grm/config.toml.tmpl")
	writeWithMode(t, mapped, "old\n", 0o640)
	// And a compose file that is too open, to prove the contract is pinned in
	// both directions rather than only ever loosened.
	writeWithMode(t, filepath.Join(projectDir, "compose.yml"), "services: {}\n", 0o644)

	rr := deployProject(t, h, client, "grm", map[string]string{
		"compose.yml":                        mappedFileCompose,
		"files/web/etc/grm/config.toml.tmpl": "new\n",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	assertMode(t, projectDir, 0o750)
	assertMode(t, filepath.Join(projectDir, "compose.yml"), 0o640)
	for _, dir := range []string{"files", "files/web", "files/web/etc", "files/web/etc/grm"} {
		assertMode(t, filepath.Join(projectDir, dir), 0o755)
	}
	assertMode(t, mapped, 0o644)

	content, err := os.ReadFile(mapped)
	if err != nil {
		t.Fatalf("read mapped file: %v", err)
	}
	if string(content) != "new\n" {
		t.Errorf("expected mapped file to be replaced, got %q", content)
	}
}

func TestDeploy_RejectsPathsOutsideProjectDir(t *testing.T) {
	h, deploymentsDir := testHandler(t)
	client := minimalClient("acme")

	for _, bad := range []string{"../escape.txt", "files/../../escape.txt", "/etc/escape.txt"} {
		rr := deployProject(t, h, client, "grm", map[string]string{
			"compose.yml": mappedFileCompose,
			bad:           "pwned",
		})
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%q: expected 400, got %d: %s", bad, rr.Code, rr.Body.String())
		}
	}

	if _, err := os.Stat(filepath.Join(deploymentsDir, "acme", "escape.txt")); !os.IsNotExist(err) {
		t.Errorf("expected no file written outside the project directory, stat err = %v", err)
	}
}

// ── Reconciler self-heal ───────────────────────────────────

func TestRedeployProject_RepairsLegacyFileModes(t *testing.T) {
	h, deploymentsDir := testHandler(t)
	client := minimalClient("acme")

	// A project deployed by an older agent: agent-private modes everywhere and a
	// stale policy hash, i.e. exactly what the reconciler picks up after the
	// filemodes hash bump.
	projectDir := filepath.Join(deploymentsDir, "acme", "grm")
	for _, dir := range []string{"", "files", "files/web", "files/web/etc"} {
		mkdirWithMode(t, filepath.Join(projectDir, dir), 0o750)
	}
	mapped := filepath.Join(projectDir, "files/web/etc/config.toml")
	writeWithMode(t, mapped, "[grm]\n", 0o640)
	writeWithMode(t, filepath.Join(projectDir, "compose.yml"), mappedFileCompose, 0o640)
	h.tracker.Set("acme", "grm", &ProjectResources{Containers: 1, PolicyHash: "stale"})

	newHash := policyHash(client, h.cfg)
	h.Reconciler().redeployProject("acme", client, "grm", newHash)

	assertMode(t, projectDir, 0o750)
	assertMode(t, filepath.Join(projectDir, "compose.yml"), 0o640)
	for _, dir := range []string{"files", "files/web", "files/web/etc"} {
		assertMode(t, filepath.Join(projectDir, dir), 0o755)
	}
	assertMode(t, mapped, 0o644)

	res := h.tracker.GetProject("acme", "grm")
	if res == nil || res.PolicyHash != newHash {
		t.Fatalf("expected tracker hash %q after redeploy, got %+v", newHash, res)
	}
}

// ── Bind-mount source confinement ──────────────────────────

// peekCompose is a single hardened-by-default service with one volume entry.
func peekCompose(volume string) string {
	return "services:\n  peek:\n    image: busybox\n    volumes:\n      - " + volume + "\n"
}

func TestDeploy_RejectsBindMountsIntoOtherProjects(t *testing.T) {
	h, deploymentsDir := testHandler(t)

	// Client b's project holds a mapped file on disk — the tree another client
	// would target now that mapped files are world-readable.
	if rr := deployProject(t, h, minimalClient("b"), "grm", map[string]string{
		"compose.yml":                        mappedFileCompose,
		"files/web/etc/grm/config.toml.tmpl": "secret\n",
	}); rr.Code != http.StatusOK {
		t.Fatalf("victim deploy: expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	victimFiles := filepath.Join(deploymentsDir, "b", "grm", "files")

	attacker := minimalClient("a")
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"absolute source", map[string]string{
			"compose.yml": peekCompose(victimFiles + ":/peek:ro"),
		}, "overlaps the agent deployments directory"},
		{"relative source", map[string]string{
			"compose.yml": peekCompose("../../b/grm/files:/peek:ro"),
		}, "overlaps the agent deployments directory"},
		{"source interpolated from the project's own .env", map[string]string{
			"compose.yml": peekCompose("${PEEK}:/peek:ro"),
			".env":        "PEEK=" + victimFiles + "\n",
		}, "interpolated"},
		{"bind volume via driver_opts", map[string]string{
			"compose.yml": peekCompose("peek:/peek:ro") +
				"volumes:\n  peek:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: " + victimFiles + "\n",
		}, "overlaps the agent deployments directory"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := deployProject(t, h, attacker, "peek", tc.files)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
			}
			if !strings.Contains(rr.Body.String(), tc.want) {
				t.Errorf("expected violation containing %q, got %s", tc.want, rr.Body.String())
			}
		})
	}

	// Validation runs before anything is written for the rejected project.
	if _, err := os.Stat(filepath.Join(deploymentsDir, "a")); !os.IsNotExist(err) {
		t.Errorf("expected nothing written for the rejected client, stat err = %v", err)
	}

	// The shape the guard exists to keep working: a read-only mount of the
	// project's own mapped file.
	rr := deployProject(t, h, attacker, "peek", map[string]string{
		"compose.yml":                        mappedFileCompose,
		"files/web/etc/grm/config.toml.tmpl": "mine\n",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("own mapped file: expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDeploy_RelativeSourceCannotBypassDenyList(t *testing.T) {
	h, _ := testHandler(t)
	h.cfg.Deny.HostPaths = []string{"/", "/etc", "/var/run/docker.sock", "/proc", "/sys", "/dev"}

	rr := deployProject(t, h, minimalClient("acme"), "grm", map[string]string{
		"compose.yml": peekCompose(strings.Repeat("../", 12) + "etc:/host-etc:ro"),
	})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
	if body := rr.Body.String(); !strings.Contains(body, "not allowed") || !strings.Contains(body, "resolves to '/etc'") {
		t.Errorf("expected a deny-list violation naming /etc, got %s", body)
	}
}

func TestDeploy_RejectsWritableMountOfProjectTree(t *testing.T) {
	h, _ := testHandler(t)
	rr := deployProject(t, h, minimalClient("acme"), "grm", map[string]string{
		"compose.yml": peekCompose("./files/peek/data:/data"),
	})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "must be mounted read-only") {
		t.Errorf("expected read-only violation, got %s", rr.Body.String())
	}
}

// ── Project name ───────────────────────────────────────────

func destroyProject(t *testing.T, h *Handler, client *config.ClientPolicy, project string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/v1/compose/projects/"+project, nil)
	req = req.WithContext(identity.WithClient(req.Context(), client))

	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /v1/compose/projects/{project}", h.Destroy)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestProjectSlug_RejectsNamesThatEscapeTheClientDir(t *testing.T) {
	h, deploymentsDir := testHandler(t)
	client := minimalClient("acme")

	// A compose file at the deployments root is what a `..` slug would resolve
	// to — and what Destroy would `RemoveAll` around.
	mkdirWithMode(t, deploymentsDir, 0o750)
	writeWithMode(t, filepath.Join(deploymentsDir, "compose.yml"), "services: {}\n", 0o640)

	// The router unescapes percent-encoded separators into the slug.
	for _, slug := range []string{"%2e%2e", "..%2f..%2fescape", "a%2fb", "-leading-dash", "with.dot", "sp%20ace"} {
		if rr := deployProject(t, h, client, slug, map[string]string{"compose.yml": mappedFileCompose}); rr.Code != http.StatusBadRequest {
			t.Errorf("deploy %q: expected 400, got %d: %s", slug, rr.Code, rr.Body.String())
		}
		if rr := destroyProject(t, h, client, slug); rr.Code != http.StatusBadRequest {
			t.Errorf("destroy %q: expected 400, got %d: %s", slug, rr.Code, rr.Body.String())
		}
	}

	if _, err := os.Stat(filepath.Join(deploymentsDir, "compose.yml")); err != nil {
		t.Errorf("expected the deployments root to be untouched, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(deploymentsDir, "..", "escape")); !os.IsNotExist(err) {
		t.Errorf("expected nothing written outside the deployments dir, stat err = %v", err)
	}

	for _, slug := range []string{"grm", "my-app_2", "A1"} {
		if rr := deployProject(t, h, client, slug, map[string]string{"compose.yml": mappedFileCompose}); rr.Code != http.StatusOK {
			t.Errorf("deploy %q: expected 200, got %d: %s", slug, rr.Code, rr.Body.String())
		}
	}
}
