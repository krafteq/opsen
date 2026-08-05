package config

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeClientPolicy(t *testing.T, dir, name, content string) string {
	t.Helper()

	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	return path
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func TestLoadClientPolicy_AcceptsUpstreamPatterns(t *testing.T) {
	path := writeClientPolicy(t, t.TempDir(), "acme.yaml", `
client: acme
ingress:
  upstreams:
    allowed_targets: ['10.0.0.5:3000-3099', '10.0.0.0/24:*', '[fd00::/8]:*']
    deny_targets: ['10.0.0.1:*', '10.0.0.5', '10.0.0.0/8', 'fd00::/8']
`)

	policy, err := loadClientPolicy(path)
	if err != nil {
		t.Fatalf("loadClientPolicy returned error: %v", err)
	}
	if len(policy.Ingress.Upstreams.DenyTargets) != 4 {
		t.Errorf("expected 4 deny targets, got %d", len(policy.Ingress.Upstreams.DenyTargets))
	}
}

// TestLoadClientPolicy_RejectsUnmatchablePatterns is the config-load half of the
// "a control that silently does not exist" defect: a pattern that can never
// match must fail the file rather than load as an inert deny list.
func TestLoadClientPolicy_RejectsUnmatchablePatterns(t *testing.T) {
	tests := []struct {
		name    string
		policy  string
		wantMsg string
	}{
		{
			name: "malformed CIDR in deny_targets",
			policy: `
client: acme
ingress:
  upstreams:
    deny_targets: ['10.0.0.0/99:*']
`,
			wantMsg: "deny_targets",
		},
		{
			name: "unbracketed IPv6 CIDR with a port half",
			policy: `
client: acme
ingress:
  upstreams:
    deny_targets: ['fd00::/8:*']
`,
			wantMsg: "deny_targets",
		},
		{
			name: "non-numeric port in allowed_targets",
			policy: `
client: acme
ingress:
  upstreams:
    allowed_targets: ['10.0.0.5:http']
`,
			wantMsg: "allowed_targets",
		},
		{
			name: "inverted port range",
			policy: `
client: acme
ingress:
  upstreams:
    allowed_targets: ['10.0.0.5:3099-3000']
`,
			wantMsg: "allowed_targets",
		},
		{
			name: "empty pattern",
			policy: `
client: acme
ingress:
  upstreams:
    deny_targets: ['']
`,
			wantMsg: "deny_targets",
		},
	}

	for _, tt := range tests {
		path := writeClientPolicy(t, t.TempDir(), "acme.yaml", tt.policy)

		_, err := loadClientPolicy(path)
		if err == nil {
			t.Errorf("%s: expected an error, got none", tt.name)
			continue
		}
		if !strings.Contains(err.Error(), tt.wantMsg) {
			t.Errorf("%s: error should name the offending field %q, got %v", tt.name, tt.wantMsg, err)
		}
	}
}

// TestClientStore_DropsInvalidPolicy pins the failure direction: a rejected
// policy file leaves the client unknown, and an unknown client is refused at the
// mTLS boundary rather than served with an inert deny list.
func TestClientStore_DropsInvalidPolicy(t *testing.T) {
	dir := t.TempDir()
	writeClientPolicy(t, dir, "good.yaml", `
client: good
ingress:
  upstreams:
    deny_targets: ['10.0.0.0/8']
`)
	writeClientPolicy(t, dir, "bad.yaml", `
client: bad
ingress:
  upstreams:
    deny_targets: ['10.0.0.0/99:*']
`)

	store, err := NewClientStore(dir, discardLogger())
	if err != nil {
		t.Fatalf("NewClientStore returned error: %v", err)
	}

	if store.Get("good") == nil {
		t.Error("expected the valid client policy to load")
	}
	if store.Get("bad") != nil {
		t.Error("expected the client with an unmatchable deny pattern to be dropped")
	}
}
