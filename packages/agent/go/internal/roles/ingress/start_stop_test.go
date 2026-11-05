package ingress

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func lifecycleMux(h *Handler) *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("PUT /apps/{app}/routes", h.UpdateAppRoutes)
	m.HandleFunc("GET /apps/{app}/routes", h.ListAppRoutes)
	m.HandleFunc("POST /apps/{app}/stop", h.StopApp)
	m.HandleFunc("POST /apps/{app}/start", h.StartApp)
	m.HandleFunc("DELETE /apps/{app}", h.DeleteApp)
	return m
}
func TestIngressLifecyclePersistsLatestRoutes(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000", PathPrefix: "/api", BindAddress: "127.0.0.1", Headers: map[string]string{"X-Test": "retained"}}}}
	call := func(method, path string, body any) {
		t.Helper()
		r := doMuxRequest(m, method, path, body, client)
		if r.Code != 200 {
			t.Fatalf("%s %s: %d %s", method, path, r.Code, r.Body.String())
		}
	}
	call("PUT", "/apps/demo/routes", routes)
	call("POST", "/apps/demo/stop", nil)
	call("POST", "/apps/demo/stop", nil)
	file := filepath.Join(dir, "tenant--demo.conf")
	assertConfig := func(want, absent string) {
		t.Helper()
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), want) || strings.Contains(string(data), absent) {
			t.Fatalf("unexpected config: %s", data)
		}
	}
	assertConfig(`respond "Environment stopped" 503`, "reverse_proxy")
	data, _ := os.ReadFile(file)
	for _, want := range []string{"handle_path /api*", "bind 127.0.0.1", "header Cache-Control no-store", "X-Content-Type-Options nosniff", "header X-Test"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("missing %q", want)
		}
	}
	// A fresh handler reads persistent stopped state on PUT and Start.
	h2 := NewHandler(h.cfg, h.clientStore, testLogger())
	m = lifecycleMux(h2)
	routes.Routes[0].Upstream = "10.0.0.2:4000"
	call("PUT", "/apps/demo/routes", routes)
	assertConfig(`respond "Environment stopped" 503`, "reverse_proxy")
	call("POST", "/apps/demo/start", nil)
	call("POST", "/apps/demo/start", nil)
	assertConfig("reverse_proxy 10.0.0.2:4000", "Environment stopped")
	call("DELETE", "/apps/demo", nil)
	if _, err := os.Stat(filepath.Join(dir, "tenant--demo.state.json")); !os.IsNotExist(err) {
		t.Fatalf("state remains: %v", err)
	}
}
func TestIngressLifecycleRejectsUnauthorizedUnsupportedAndMissing(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	noRole := testClient("other")
	noRole.Ingress = nil
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, noRole); r.Code != 403 {
		t.Fatal(r.Code)
	}
	if r := doMuxRequest(m, "POST", "/apps/bad%21name/stop", nil, client); r.Code != 400 {
		t.Fatal(r.Code)
	}
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 404 {
		t.Fatal(r.Code)
	}
	h.driver = &TraefikDriver{configDir: dir}
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 501 {
		t.Fatal(r.Code)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("rejection mutated files")
	}
}
func TestIngressLifecycleReloadFailureRetry(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}}
	if r := doMuxRequest(m, "PUT", "/apps/demo/routes", routes, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	d := h.driver.(*CaddyDriver)
	d.reloadCmd = "/bin/false"
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 500 {
		t.Fatal(r.Code)
	}
	fresh := &CaddyDriver{configDir: dir}
	state, err := fresh.readState("tenant", "demo")
	if err != nil || !state.Stopped {
		t.Fatalf("stop state lost: %v", err)
	}
	d.reloadCmd = "/bin/true"
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
}

func TestIngressLifecycleLegacyAndCorruptState(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	if err := os.WriteFile(filepath.Join(dir, "tenant--demo.conf"), []byte("app.example.com {\n reverse_proxy localhost:3000\n}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 409 {
		t.Fatal(r.Code)
	}
	if err := os.WriteFile(filepath.Join(dir, "tenant--demo.state.json"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ method, path string }{{"GET", "/apps/demo/routes"}, {"POST", "/apps/demo/start"}, {"POST", "/apps/demo/stop"}} {
		if r := doMuxRequest(m, entry.method, entry.path, nil, client); r.Code != 500 {
			t.Fatalf("%s: %d", entry.path, r.Code)
		}
	}
}
func TestIngressStartRevalidatesPolicy(t *testing.T) {
	h, _ := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}}
	if r := doMuxRequest(m, "PUT", "/apps/demo/routes", routes, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	client.Ingress.Domains.Allowed = []string{"*.different.example"}
	// Policy restriction must not prevent a safety stop, but must block Start.
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	if r := doMuxRequest(m, "POST", "/apps/demo/start", nil, client); r.Code != 400 {
		t.Fatal(r.Code)
	}
	state, err := h.driver.(*CaddyDriver).readState("tenant", "demo")
	if err != nil || !state.Stopped {
		t.Fatalf("failed Start changed state: %v", err)
	}
}
