package config

import (
	"os"
	"testing"
)

func TestLoadDefaultsPidLimit(t *testing.T) {
	path := writeConfig(t, `
listen: ":8443"
tls:
  cert: /tmp/server.pem
  key: /tmp/server-key.pem
  ca: /tmp/ca.pem
`)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.GlobalHardening.PidLimit != DefaultPidLimit {
		t.Errorf("expected default pid limit %d, got %d", DefaultPidLimit, cfg.GlobalHardening.PidLimit)
	}
}

func TestLoadPreservesPidLimit(t *testing.T) {
	path := writeConfig(t, `
listen: ":8443"
tls:
  cert: /tmp/server.pem
  key: /tmp/server-key.pem
  ca: /tmp/ca.pem
global_hardening:
  pid_limit: 512
`)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.GlobalHardening.PidLimit != 512 {
		t.Errorf("expected configured pid limit 512, got %d", cfg.GlobalHardening.PidLimit)
	}
}

func writeConfig(t *testing.T, content string) string {
	t.Helper()

	file, err := os.CreateTemp(t.TempDir(), "agent-*.yaml")
	if err != nil {
		t.Fatalf("CreateTemp returned error: %v", err)
	}
	defer file.Close()

	if _, err := file.WriteString(content); err != nil {
		t.Fatalf("WriteString returned error: %v", err)
	}

	return file.Name()
}
