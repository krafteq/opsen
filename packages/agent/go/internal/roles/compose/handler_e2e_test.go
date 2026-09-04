//go:build e2e

// End-to-end coverage of the compose role against a real Docker Engine.
//
// Excluded from the default `go test ./...` run by the build tag. Run with:
//
//	go test -tags e2e ./internal/roles/compose/ -run E2E -v
//
// Requires a local, rootful Docker Engine (no userns remap) with the compose
// plugin; pulls busybox.

package compose

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

func requireDocker(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("bind-mount e2e needs a Linux Docker host")
	}
	if out, err := exec.Command("docker", "compose", "version").CombinedOutput(); err != nil {
		t.Skipf("docker compose not available: %v: %s", err, out)
	}
}

// foreignID picks a uid/gid the test process does not hold (neither its uid,
// its primary gid nor any supplementary group), so the container can only read
// the mapped files through the "other" permission bits — the position the
// injected default_user is in on a real VM, where the agent runs as the
// opsen-agent system user and never matches the service uid.
func foreignID() int {
	held := map[int]bool{os.Getuid(): true, os.Getgid(): true}
	if groups, err := os.Getgroups(); err == nil {
		for _, g := range groups {
			held[g] = true
		}
	}
	for id := 1000; ; id++ {
		if !held[id] {
			return id
		}
	}
}

func dockerOutput(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func waitForContainerExit(t *testing.T, container string, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		out, err := exec.Command("docker", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", container).CombinedOutput()
		if err == nil {
			var status string
			var code int
			if _, serr := fmt.Sscanf(strings.TrimSpace(string(out)), "%s %d", &status, &code); serr == nil && status == "exited" {
				return code
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("container %s did not exit within %s (last inspect: %v %s)", container, timeout, err, out)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

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

// A hardened service — non-root user unrelated to the host user, cap_drop ALL,
// read-only rootfs, no-new-privileges — must be able to read a MappedFile that
// is bind-mounted read-only from the project's files/ tree, both as a single
// file mount and as a directory mount.
func TestE2E_HardenedNonRootServiceReadsMappedFiles(t *testing.T) {
	requireDocker(t)

	uid := foreignID()
	deploymentsDir := filepath.Join(t.TempDir(), "deployments")
	cfg := minimalConfig()
	cfg.Roles.Compose = &config.ComposeRoleConfig{
		ComposeBinary:  "docker compose",
		DeploymentsDir: deploymentsDir,
	}
	cfg.GlobalHardening = config.GlobalHardening{
		NoNewPrivileges: true,
		CapDropAll:      true,
		ReadOnlyRootfs:  true,
		DefaultUser:     fmt.Sprintf("%d:%d", uid, uid),
		DefaultTmpfs:    []config.TmpfsMount{{Path: "/tmp", Options: "noexec,nosuid,size=16m"}},
	}
	clientStore, err := config.NewClientStore(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("NewClientStore: %v", err)
	}
	h := NewHandler(cfg, clientStore, testLogger())
	client := minimalClient("e2e")

	const project = "mapped"
	container := fmt.Sprintf("opsen-%s-%s-reader-1", client.Client, project)

	const configContent = "[app]\nname = \"opsen-e2e-mapped-file\"\n"
	const caContent = "-----BEGIN CERTIFICATE-----\nopsen-e2e-ca\n-----END CERTIFICATE-----\n"
	files := map[string]string{
		"compose.yml": `services:
  reader:
    image: busybox
    command: ["sh", "-c", "cat /etc/app/config.toml /etc/app/certs/ca.pem && echo MAPPED_FILE_OK"]
    volumes:
      - ./files/reader/etc/app/config.toml:/etc/app/config.toml:ro
      - ./files/reader/etc/app/certs:/etc/app/certs:ro
`,
		"files/reader/etc/app/config.toml":  configContent,
		"files/reader/etc/app/certs/ca.pem": caContent,
	}

	t.Cleanup(func() {
		if rr := destroyProject(t, h, client, project); rr.Code != http.StatusOK {
			t.Logf("destroy returned %d: %s", rr.Code, rr.Body.String())
		}
	})

	rr := deployProject(t, h, client, project, files)
	if rr.Code != http.StatusOK {
		t.Fatalf("deploy: expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	exitCode := waitForContainerExit(t, container, 90*time.Second)
	logs := dockerOutput(t, "logs", container)
	if exitCode != 0 {
		t.Fatalf("reader exited %d; logs:\n%s", exitCode, logs)
	}
	for _, want := range []string{"opsen-e2e-mapped-file", "opsen-e2e-ca", "MAPPED_FILE_OK"} {
		if !strings.Contains(logs, want) {
			t.Errorf("expected container output to contain %q, got:\n%s", want, logs)
		}
	}

	// The read must have happened under the hardening that made it fail before:
	// unrelated non-root uid, no capabilities (so no DAC_OVERRIDE), read-only rootfs.
	inspect := strings.TrimSpace(dockerOutput(t, "inspect", "-f",
		"{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{join .HostConfig.CapDrop \",\"}}", container))
	wantUser := fmt.Sprintf("%d:%d", uid, uid)
	parts := strings.Split(inspect, "|")
	if len(parts) != 3 || parts[0] != wantUser || parts[1] != "true" || !strings.Contains(parts[2], "ALL") {
		t.Errorf("expected container to run as %s with read-only rootfs and cap_drop ALL, got %q", wantUser, inspect)
	}
}
