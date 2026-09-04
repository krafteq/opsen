package compose

import (
	"os"
	"path/filepath"
	"testing"
)

func TestApplyProjectFileModes_LeavesSymlinkTargetsAlone(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, "project")
	mkdirWithMode(t, filepath.Join(projectDir, "files", "web"), 0o750)
	writeWithMode(t, filepath.Join(projectDir, "files", "web", "app.toml"), "x", 0o640)
	writeWithMode(t, filepath.Join(projectDir, "compose.yml"), "services: {}\n", 0o600)

	// Agent-owned things outside the project tree that a compromised container
	// with a writable bind mount below the project dir could point a symlink at.
	secretFile := filepath.Join(root, "server-key.pem")
	writeWithMode(t, secretFile, "key", 0o600)
	privateDir := filepath.Join(root, "private")
	mkdirWithMode(t, privateDir, 0o700)
	if err := os.Symlink(secretFile, filepath.Join(projectDir, "files", "web", "key")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if err := os.Symlink(privateDir, filepath.Join(projectDir, "files", "dir")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if err := applyProjectFileModes(projectDir); err != nil {
		t.Fatalf("applyProjectFileModes: %v", err)
	}

	// The contract is applied to what the agent owns inside the tree...
	assertMode(t, projectDir, 0o750)
	assertMode(t, filepath.Join(projectDir, "compose.yml"), 0o640)
	assertMode(t, filepath.Join(projectDir, "files"), 0o755)
	assertMode(t, filepath.Join(projectDir, "files", "web"), 0o755)
	assertMode(t, filepath.Join(projectDir, "files", "web", "app.toml"), 0o644)
	// ...and never followed through a symlink.
	assertMode(t, secretFile, 0o600)
	assertMode(t, privateDir, 0o700)
}

func TestApplyProjectFileModes_MissingProjectDir(t *testing.T) {
	if err := applyProjectFileModes(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected an error for a missing project directory")
	}
}

func TestEnsureProjectSubdirs_RejectsDirOutsideProject(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, "project")
	mkdirWithMode(t, projectDir, 0o750)

	if err := ensureProjectSubdirs(projectDir, filepath.Join(root, "elsewhere")); err == nil {
		t.Fatal("expected an error for a directory outside the project")
	}
	if err := ensureProjectSubdirs(projectDir, projectDir); err != nil {
		t.Fatalf("project dir itself should be a no-op, got %v", err)
	}
	assertMode(t, projectDir, 0o750)
}
