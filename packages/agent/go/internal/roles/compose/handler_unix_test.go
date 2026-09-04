//go:build unix

package compose

import (
	"net/http"
	"path/filepath"
	"syscall"
	"testing"
)

// The agent's systemd unit does not pin a umask, so the project file contract
// must not depend on the one the process happens to inherit.
func TestDeploy_ModesIndependentOfUmask(t *testing.T) {
	old := syscall.Umask(0o077)
	t.Cleanup(func() { syscall.Umask(old) })

	h, deploymentsDir := testHandler(t)
	client := minimalClient("acme")

	rr := deployProject(t, h, client, "grm", map[string]string{
		"compose.yml":                        mappedFileCompose,
		"files/web/etc/grm/config.toml.tmpl": "[grm]\n",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	projectDir := filepath.Join(deploymentsDir, "acme", "grm")
	assertMode(t, filepath.Join(deploymentsDir, "acme"), 0o750)
	assertMode(t, projectDir, 0o750)
	assertMode(t, filepath.Join(projectDir, "compose.yml"), 0o640)
	for _, dir := range []string{"files", "files/web", "files/web/etc", "files/web/etc/grm"} {
		assertMode(t, filepath.Join(projectDir, dir), 0o755)
	}
	assertMode(t, filepath.Join(projectDir, "files/web/etc/grm/config.toml.tmpl"), 0o644)
}
