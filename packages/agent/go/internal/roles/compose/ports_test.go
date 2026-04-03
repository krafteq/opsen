package compose

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func tempPortAllocator(t *testing.T, portRange string) *PortAllocator {
	t.Helper()
	path := filepath.Join(t.TempDir(), "port-state.json")
	pa, err := NewPortAllocator(path, portRange, testLogger())
	if err != nil {
		t.Fatalf("NewPortAllocator: %v", err)
	}
	return pa
}

func TestPortAllocator_AllocateBasic(t *testing.T) {
	pa := tempPortAllocator(t, "8000-8999")

	requests := []ServicePort{
		{Service: "web", ContainerPort: "80"},
		{Service: "api", ContainerPort: "3000"},
	}

	mappings, err := pa.Allocate("client1", "project1", requests)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	if len(mappings) != 2 {
		t.Fatalf("expected 2 mappings, got %d", len(mappings))
	}

	if mappings[0].HostPort != 8000 {
		t.Errorf("expected first port 8000, got %d", mappings[0].HostPort)
	}
	if mappings[0].Service != "web" || mappings[0].ContainerPort != "80" {
		t.Errorf("unexpected mapping[0]: %+v", mappings[0])
	}
	if mappings[1].HostPort != 8001 {
		t.Errorf("expected second port 8001, got %d", mappings[1].HostPort)
	}
}

func TestPortAllocator_ReusesExisting(t *testing.T) {
	pa := tempPortAllocator(t, "8000-8999")

	requests := []ServicePort{{Service: "web", ContainerPort: "80"}}

	first, err := pa.Allocate("client1", "project1", requests)
	if err != nil {
		t.Fatalf("first Allocate: %v", err)
	}

	second, err := pa.Allocate("client1", "project1", requests)
	if err != nil {
		t.Fatalf("second Allocate: %v", err)
	}

	if first[0].HostPort != second[0].HostPort {
		t.Errorf("expected reuse: first=%d, second=%d", first[0].HostPort, second[0].HostPort)
	}
}

func TestPortAllocator_ReallocatesOnChange(t *testing.T) {
	pa := tempPortAllocator(t, "8000-8999")

	first, err := pa.Allocate("client1", "project1", []ServicePort{
		{Service: "web", ContainerPort: "80"},
	})
	if err != nil {
		t.Fatalf("first Allocate: %v", err)
	}

	// Change exposed ports — should reallocate
	second, err := pa.Allocate("client1", "project1", []ServicePort{
		{Service: "web", ContainerPort: "8080"},
	})
	if err != nil {
		t.Fatalf("second Allocate: %v", err)
	}

	if second[0].ContainerPort != "8080" {
		t.Errorf("expected container port 8080, got %s", second[0].ContainerPort)
	}
	// Should get port 8000 again since old allocation is replaced
	if second[0].HostPort != first[0].HostPort {
		t.Errorf("expected port reuse after replace: first=%d, second=%d", first[0].HostPort, second[0].HostPort)
	}
}

func TestPortAllocator_IsolatesBetweenClients(t *testing.T) {
	pa := tempPortAllocator(t, "8000-8001")

	_, err := pa.Allocate("client1", "proj", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("client1 Allocate: %v", err)
	}

	mappings, err := pa.Allocate("client2", "proj", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("client2 Allocate: %v", err)
	}

	if mappings[0].HostPort != 8001 {
		t.Errorf("expected client2 to get 8001, got %d", mappings[0].HostPort)
	}
}

func TestPortAllocator_RangeExhaustion(t *testing.T) {
	pa := tempPortAllocator(t, "8000-8001")

	_, err := pa.Allocate("c1", "p1", []ServicePort{{Service: "a", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	_, err = pa.Allocate("c1", "p2", []ServicePort{{Service: "a", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("second: %v", err)
	}

	_, err = pa.Allocate("c1", "p3", []ServicePort{{Service: "a", ContainerPort: "80"}})
	if err == nil {
		t.Fatal("expected error on range exhaustion")
	}
}

func TestPortAllocator_Release(t *testing.T) {
	pa := tempPortAllocator(t, "8000-8000") // single port

	_, err := pa.Allocate("c1", "p1", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	// Range is exhausted
	_, err = pa.Allocate("c1", "p2", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err == nil {
		t.Fatal("expected exhaustion error")
	}

	// Release frees the port
	pa.Release("c1", "p1")

	mappings, err := pa.Allocate("c1", "p2", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("Allocate after release: %v", err)
	}
	if mappings[0].HostPort != 8000 {
		t.Errorf("expected port 8000 after release, got %d", mappings[0].HostPort)
	}
}

func TestPortAllocator_Persistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "port-state.json")

	// Allocate with first instance
	pa1, err := NewPortAllocator(path, "8000-8999", testLogger())
	if err != nil {
		t.Fatalf("NewPortAllocator: %v", err)
	}
	_, err = pa1.Allocate("c1", "p1", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	// Load second instance from same file
	pa2, err := NewPortAllocator(path, "8000-8999", testLogger())
	if err != nil {
		t.Fatalf("NewPortAllocator reload: %v", err)
	}

	pp := pa2.GetProject("c1", "p1")
	if pp == nil {
		t.Fatal("expected project ports to be persisted")
	}
	if len(pp.Ports) != 1 || pp.Ports[0].HostPort != 8000 {
		t.Errorf("unexpected persisted ports: %+v", pp.Ports)
	}

	// New allocation should get next port (8000 is taken)
	mappings, err := pa2.Allocate("c1", "p2", []ServicePort{{Service: "api", ContainerPort: "3000"}})
	if err != nil {
		t.Fatalf("Allocate on reloaded: %v", err)
	}
	if mappings[0].HostPort != 8001 {
		t.Errorf("expected 8001 on reloaded allocator, got %d", mappings[0].HostPort)
	}
}

func TestPortAllocator_PersistenceFileFormat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "port-state.json")

	pa, err := NewPortAllocator(path, "8000-8999", testLogger())
	if err != nil {
		t.Fatalf("NewPortAllocator: %v", err)
	}
	_, err = pa.Allocate("deployer", "myapp", []ServicePort{{Service: "web", ContainerPort: "80"}})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("JSON parse: %v", err)
	}

	clients, ok := parsed["clients"].(map[string]any)
	if !ok {
		t.Fatal("expected clients key in persisted JSON")
	}
	deployer, ok := clients["deployer"].(map[string]any)
	if !ok {
		t.Fatal("expected deployer client in persisted JSON")
	}
	if _, ok := deployer["myapp"]; !ok {
		t.Fatal("expected myapp project in persisted JSON")
	}
}

func TestParsePortRange(t *testing.T) {
	tests := []struct {
		input   string
		wantMin int
		wantMax int
		wantErr bool
	}{
		{"8000-8999", 8000, 8999, false},
		{"80-80", 80, 80, false},
		{"", 0, 0, true},
		{"8000", 0, 0, true},
		{"9000-8000", 0, 0, true},   // min > max
		{"0-100", 0, 0, true},       // port 0 invalid
		{"abc-def", 0, 0, true},     // non-numeric
		{"1-65535", 1, 65535, false}, // full range
		{"1-65536", 0, 0, true},     // exceeds max
	}

	for _, tt := range tests {
		min, max, err := parsePortRange(tt.input)
		if tt.wantErr {
			if err == nil {
				t.Errorf("parsePortRange(%q): expected error", tt.input)
			}
			continue
		}
		if err != nil {
			t.Errorf("parsePortRange(%q): unexpected error: %v", tt.input, err)
			continue
		}
		if min != tt.wantMin || max != tt.wantMax {
			t.Errorf("parsePortRange(%q) = (%d, %d), want (%d, %d)", tt.input, min, max, tt.wantMin, tt.wantMax)
		}
	}
}

func TestExtractExposeEntries(t *testing.T) {
	compose := &ComposeFile{
		Services: map[string]*ComposeService{
			"web": {Expose: []string{"80", "443"}},
			"api": {Expose: []string{"3000/tcp"}},
			"db":  {}, // no expose
		},
	}

	entries := extractExposeEntries(compose)

	// Collect into a map for order-independent assertions
	type key struct{ svc, port string }
	got := make(map[key]bool)
	for _, e := range entries {
		got[key{e.Service, e.ContainerPort}] = true
	}

	expected := []key{
		{"web", "80"},
		{"web", "443"},
		{"api", "3000"},
	}

	if len(entries) != len(expected) {
		t.Fatalf("expected %d entries, got %d", len(expected), len(entries))
	}
	for _, e := range expected {
		if !got[e] {
			t.Errorf("missing entry: %+v", e)
		}
	}
}

func TestPortsMatch(t *testing.T) {
	existing := []PortMapping{
		{HostPort: 8000, ContainerPort: "80", Service: "web"},
		{HostPort: 8001, ContainerPort: "3000", Service: "api"},
	}

	// Same requests — should match
	if !portsMatch(existing, []ServicePort{
		{Service: "web", ContainerPort: "80"},
		{Service: "api", ContainerPort: "3000"},
	}) {
		t.Error("expected match for identical requests")
	}

	// Different count — should not match
	if portsMatch(existing, []ServicePort{
		{Service: "web", ContainerPort: "80"},
	}) {
		t.Error("expected no match for different count")
	}

	// Different port — should not match
	if portsMatch(existing, []ServicePort{
		{Service: "web", ContainerPort: "8080"},
		{Service: "api", ContainerPort: "3000"},
	}) {
		t.Error("expected no match for different port")
	}
}
