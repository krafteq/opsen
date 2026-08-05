package ingress

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opsen/agent/internal/config"
)

// testHandlerWithDriver mirrors testHandler but lets the test pick the driver.
func testHandlerWithDriver(t *testing.T, driver string) (*Handler, string) {
	t.Helper()
	configDir := t.TempDir()
	cfg := &config.AgentConfig{
		Roles: config.RolesConfig{
			Ingress: &config.IngressRoleConfig{
				Driver:    driver,
				ConfigDir: configDir,
			},
		},
	}
	clientStore, err := config.NewClientStore(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("NewClientStore: %v", err)
	}
	return NewHandler(cfg, clientStore, testLogger()), configDir
}

// reverseProxyLines returns every `reverse_proxy` line of a generated Caddy
// config, indentation included, so assertions can pin the full emitted line.
func reverseProxyLines(t *testing.T, content string) []string {
	t.Helper()
	var out []string
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "reverse_proxy") {
			out = append(out, line)
		}
	}
	return out
}

func writeCaddyConfig(t *testing.T, routes []Route) string {
	t.Helper()
	dir := t.TempDir()
	d := &CaddyDriver{configDir: dir}
	if err := d.ValidateRoutes(routes); err != nil {
		t.Fatalf("ValidateRoutes: %v", err)
	}
	if err := d.WriteConfig("acme", "web", routes); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "acme--web.conf"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	return string(data)
}

// traefikServerURLs returns the loadBalancer server URLs of every service.
func traefikServerURLs(t *testing.T, cfg map[string]any) []string {
	t.Helper()
	httpSection, ok := cfg["http"].(map[string]any)
	if !ok {
		t.Fatalf("config has no http section: %#v", cfg)
	}
	services, ok := httpSection["services"].(map[string]any)
	if !ok {
		t.Fatalf("config has no services section: %#v", httpSection)
	}
	var urls []string
	for _, svc := range services {
		lb := svc.(map[string]any)["loadBalancer"].(map[string]any)
		for _, server := range lb["servers"].([]map[string]string) {
			urls = append(urls, server["url"])
		}
	}
	return urls
}

// ── Caddy: the flag is the only difference in the emitted upstream ──

func TestCaddyWriteConfig_UpstreamScheme(t *testing.T) {
	// The two inputs differ only in BackendProtocol.
	base := Route{Name: "grpc", Hosts: []string{"app.example.com"}, Upstream: "app:8080"}

	h2c := base
	h2c.BackendProtocol = BackendProtocolH2C

	defaultLines := reverseProxyLines(t, writeCaddyConfig(t, []Route{base}))
	h2cLines := reverseProxyLines(t, writeCaddyConfig(t, []Route{h2c}))

	if len(defaultLines) != 1 || defaultLines[0] != "  reverse_proxy app:8080" {
		t.Errorf("default upstream: expected exactly [%q], got %q", "  reverse_proxy app:8080", defaultLines)
	}
	if len(h2cLines) != 1 || h2cLines[0] != "  reverse_proxy h2c://app:8080" {
		t.Errorf("h2c upstream: expected exactly [%q], got %q", "  reverse_proxy h2c://app:8080", h2cLines)
	}
}

func TestCaddyWriteConfig_ExplicitHTTPMatchesDefault(t *testing.T) {
	base := Route{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "app:8080"}
	explicit := base
	explicit.BackendProtocol = BackendProtocolHTTP

	if got, want := writeCaddyConfig(t, []Route{explicit}), writeCaddyConfig(t, []Route{base}); got != want {
		t.Errorf("explicit \"http\" should be byte-identical to unset:\n got: %q\nwant: %q", got, want)
	}
}

// ── Traefik: same pair, same conclusion ─────────────────

func TestTraefikBuildConfig_UpstreamScheme(t *testing.T) {
	d := &TraefikDriver{configDir: t.TempDir()}
	base := Route{Name: "grpc", Hosts: []string{"app.example.com"}, Upstream: "app:8080"}

	h2c := base
	h2c.BackendProtocol = BackendProtocolH2C

	defaultURLs := traefikServerURLs(t, d.buildConfig("acme", "web", []Route{base}))
	h2cURLs := traefikServerURLs(t, d.buildConfig("acme", "web", []Route{h2c}))

	if len(defaultURLs) != 1 || defaultURLs[0] != "http://app:8080" {
		t.Errorf("default URL: expected exactly [%q], got %q", "http://app:8080", defaultURLs)
	}
	if len(h2cURLs) != 1 || h2cURLs[0] != "h2c://app:8080" {
		t.Errorf("h2c URL: expected exactly [%q], got %q", "h2c://app:8080", h2cURLs)
	}
}

// ── Wire contract: the JSON @opsen/agent's toApiRoute sends ──

// wireRouteH2C is verbatim the body toApiRoute() in
// packages/agent/src/resources/ingress-routes.ts produces for a route with
// backendProtocol: 'h2c'. Keep the two in sync.
const wireRouteH2C = `{
  "routes": [
    {
      "name": "grpc",
      "hosts": ["app.example.com"],
      "upstream": "app:8080",
      "backend_protocol": "h2c"
    }
  ]
}`

func TestUpdateAppRoutes_H2CWireFormat(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/grpcapp/routes", json.RawMessage(wireRouteH2C), client)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	data, err := os.ReadFile(filepath.Join(configDir, "acme--grpcapp.conf"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	lines := reverseProxyLines(t, string(data))
	if len(lines) != 1 || lines[0] != "  reverse_proxy h2c://app:8080" {
		t.Errorf("expected exactly [%q], got %q", "  reverse_proxy h2c://app:8080", lines)
	}

	// The h2c form must not change what parseRoutes sees: it reads top-level
	// lines only, and the scheme lives on an indented one.
	rr = doMuxRequest(mux, "GET", "/v1/ingress/apps/grpcapp/routes", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET routes: %d %s", rr.Code, rr.Body.String())
	}
	resp := parseResponse(t, rr)
	routes := resp["routes"].([]any)
	if len(routes) != 1 || routes[0] != "app.example.com" {
		t.Errorf("expected [app.example.com], got %v", routes)
	}

	count, err := h.driver.CountAllRoutes("acme")
	if err != nil {
		t.Fatalf("CountAllRoutes: %v", err)
	}
	if count != 1 {
		t.Errorf("expected CountAllRoutes=1, got %d", count)
	}
}

// ── Rejection branches ──────────────────────────────────

func TestUpdateAppRoutes_CaddyRejectsH2CWithPathPrefix(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	configFile := filepath.Join(configDir, "acme--grpcapp.conf")

	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/grpcapp/routes", RouteRequest{
		Routes: []Route{{
			Name:            "grpc-route",
			Hosts:           []string{"app.example.com"},
			Upstream:        "app:8080",
			PathPrefix:      "/api",
			BackendProtocol: BackendProtocolH2C,
		}},
	}, client)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
	resp := parseResponse(t, rr)
	msg, _ := resp["error"].(string)
	if !strings.Contains(msg, "grpc-route") {
		t.Errorf("error should name the offending route, got %q", msg)
	}

	// Nothing written: the file did not exist before and must not exist now.
	if _, err := os.Stat(configFile); !os.IsNotExist(err) {
		t.Errorf("rejected PUT must not create %s", configFile)
	}
}

func TestUpdateAppRoutes_RejectedPutLeavesExistingConfigByteIdentical(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	configFile := filepath.Join(configDir, "acme--grpcapp.conf")

	// Establish a good config first.
	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/grpcapp/routes", RouteRequest{
		Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "app:8080"}},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("setup PUT: %d %s", rr.Code, rr.Body.String())
	}
	before, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}

	// Now a rejected one.
	rr = doMuxRequest(mux, "PUT", "/v1/ingress/apps/grpcapp/routes", RouteRequest{
		Routes: []Route{{
			Name:            "grpc-route",
			Hosts:           []string{"app.example.com"},
			Upstream:        "app:9090",
			PathPrefix:      "/api",
			BackendProtocol: BackendProtocolH2C,
		}},
	}, client)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}

	after, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatalf("read config after rejection: %v", err)
	}
	if string(after) != string(before) {
		t.Errorf("rejected PUT modified the config file:\nbefore: %q\n after: %q", before, after)
	}
}

func TestUpdateAppRoutes_RejectsUnknownBackendProtocol(t *testing.T) {
	for _, driver := range []string{"caddy", "traefik"} {
		for _, value := range []string{"h2", "grpc", "HTTP", "https", "H2C"} {
			t.Run(driver+"/"+value, func(t *testing.T) {
				h, configDir := testHandlerWithDriver(t, driver)
				mux := setupMux(h)
				client := testClient("acme")

				rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/grpcapp/routes", RouteRequest{
					Routes: []Route{{
						Name:            "bad-route",
						Hosts:           []string{"app.example.com"},
						Upstream:        "app:8080",
						BackendProtocol: value,
					}},
				}, client)

				if rr.Code != http.StatusBadRequest {
					t.Fatalf("backend_protocol %q: expected 400, got %d: %s", value, rr.Code, rr.Body.String())
				}
				resp := parseResponse(t, rr)
				msg, _ := resp["error"].(string)
				if !strings.Contains(msg, "bad-route") {
					t.Errorf("error should name the offending route, got %q", msg)
				}

				entries, err := os.ReadDir(configDir)
				if err != nil {
					t.Fatalf("read configDir: %v", err)
				}
				if len(entries) != 0 {
					t.Errorf("rejected PUT must write nothing, found %d file(s) in configDir", len(entries))
				}
			})
		}
	}
}

// ── The Caddy rejection is driver-scoped ────────────────

func TestUpdateAppRoutes_TraefikAcceptsH2CWithPathPrefix(t *testing.T) {
	h, configDir := testHandlerWithDriver(t, "traefik")
	mux := setupMux(h)
	client := testClient("acme")

	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/grpcapp/routes", RouteRequest{
		Routes: []Route{{
			Name:            "grpc-route",
			Hosts:           []string{"app.example.com"},
			Upstream:        "app:8080",
			PathPrefix:      "/api",
			BackendProtocol: BackendProtocolH2C,
		}},
	}, client)

	if rr.Code != http.StatusOK {
		t.Fatalf("Traefik should accept h2c + path prefix, got %d: %s", rr.Code, rr.Body.String())
	}

	data, err := os.ReadFile(filepath.Join(configDir, "acme--grpcapp.yml"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), "url: h2c://app:8080") {
		t.Errorf("expected h2c service URL in:\n%s", data)
	}
	if !strings.Contains(string(data), "PathPrefix(`/api`)") {
		t.Errorf("expected PathPrefix rule to survive in:\n%s", data)
	}

	// The h2c form must not change what the Traefik parseRoutes sees either.
	rr = doMuxRequest(mux, "GET", "/v1/ingress/apps/grpcapp/routes", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET routes: %d %s", rr.Code, rr.Body.String())
	}
	routes := parseResponse(t, rr)["routes"].([]any)
	if len(routes) != 1 {
		t.Errorf("expected 1 route listed, got %v", routes)
	}

	count, err := h.driver.CountAllRoutes("acme")
	if err != nil {
		t.Fatalf("CountAllRoutes: %v", err)
	}
	if count != 1 {
		t.Errorf("expected CountAllRoutes=1, got %d", count)
	}
}
