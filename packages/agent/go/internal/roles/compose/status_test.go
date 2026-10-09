package compose

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

func TestContainersJSON(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{"empty", "  \n", `[]`},
		{"legacy array", `[{"Name":"a"},{"Name":"b"}]`, `[{"Name":"a"},{"Name":"b"}]`},
		{"single object", "{\"Name\":\"a\"}\n", `[{"Name":"a"}]`},
		{"ndjson", "{\"Name\":\"a\"}\n{\"Name\":\"b\"}\n", `[{"Name":"a"},{"Name":"b"}]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := containersJSON([]byte(tc.output))
			if err != nil {
				t.Fatalf("containersJSON: %v", err)
			}
			if string(got) != tc.want {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
	for _, bad := range []string{`{"Name":`, `[{"Name":"a"}`, "WARN obsolete\n{}"} {
		if _, err := containersJSON([]byte(bad)); err == nil {
			t.Errorf("containersJSON(%q): expected error", bad)
		}
	}
}

// statusWithCompose runs GET /v1/compose/projects/{project} against a fake
// compose binary that prints the given stdout and stderr.
func statusWithCompose(t *testing.T, stdout, stderr string) map[string]any {
	t.Helper()
	h, _ := testHandler(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "stdout"), []byte(stdout), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stderr"), []byte(stderr), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "docker")
	script := "#!/bin/sh\ncat " + filepath.Join(dir, "stderr") + " >&2\ncat " + filepath.Join(dir, "stdout") + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	h.cfg.Roles.Compose.ComposeBinary = bin

	req := httptest.NewRequest(http.MethodGet, "/v1/compose/projects/web", nil)
	req = req.WithContext(identity.WithClient(req.Context(), &config.ClientPolicy{Client: "app"}))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/compose/projects/{project}", h.Status)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status code %d: %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON (%v): %q", err, rr.Body.String())
	}
	return body
}

func TestStatusMultiContainerNDJSON(t *testing.T) {
	body := statusWithCompose(t,
		"{\"Name\":\"a\",\"Project\":\"opsen-app-web\"}\n{\"Name\":\"b\",\"Project\":\"opsen-app-web\"}\n",
		"WARN[0000] the attribute `version` is obsolete\n")
	if body["project"] != "opsen-app-web" || body["status"] != "running" {
		t.Fatalf("unexpected project/status: %v", body)
	}
	containers, ok := body["containers"].([]any)
	if !ok || len(containers) != 2 {
		t.Fatalf("expected 2 containers, got %#v", body["containers"])
	}
}

func TestStatusInvalidOutputIsUnknown(t *testing.T) {
	body := statusWithCompose(t, "not json\n", "")
	if body["status"] != "unknown" {
		t.Fatalf("expected unknown status, got %v", body["status"])
	}
	if containers, ok := body["containers"].([]any); !ok || len(containers) != 0 {
		t.Fatalf("expected empty containers, got %#v", body["containers"])
	}
}
