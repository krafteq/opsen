package config

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type ClientPolicy struct {
	Client  string         `yaml:"client"`
	Compose *ComposePolicy `yaml:"compose,omitempty"`
	Ingress *IngressPolicy `yaml:"ingress,omitempty"`
	Db      *DbPolicy      `yaml:"db,omitempty"`
}

// ComposePolicy governs Docker Compose project deployments.
// Resource limits (max_containers, max_memory_mb, max_cpus) are tracked
// across ALL projects for the client, not per-project.
type ComposePolicy struct {
	// Cross-project resource limits
	MaxContainers int     `yaml:"max_containers"`
	MaxMemoryMb   int     `yaml:"max_memory_mb"`
	MaxCpus       float64 `yaml:"max_cpus"`
	MaxProjects   int     `yaml:"max_projects"`

	// Per-container defaults and limits
	PerContainer PerContainerLimits `yaml:"per_container"`

	// Per-project limits
	MaxServices int  `yaml:"max_services"`
	AllowBuild  bool `yaml:"allow_build"`
	AllowEnvFile bool `yaml:"allow_env_file"`

	// Policies
	Network      NetworkPolicy    `yaml:"network"`
	Volumes      VolumePolicy     `yaml:"volumes"`
	Images       ImagePolicy      `yaml:"images"`
	Capabilities CapabilityPolicy `yaml:"capabilities"`
}

type PerContainerLimits struct {
	DefaultMemoryMb int     `yaml:"default_memory_mb"`
	DefaultCpus     float64 `yaml:"default_cpus"`
	MaxMemoryMb     int     `yaml:"max_memory_mb"`
	MaxCpus         float64 `yaml:"max_cpus"`
	MaxPids         int     `yaml:"max_pids"`
}

type NetworkPolicy struct {
	InternetAccess     bool     `yaml:"internet_access"`
	AllowedEgress      []string `yaml:"allowed_egress"`
	IngressPortRange   string   `yaml:"ingress_port_range"`
	IngressBindAddress string   `yaml:"ingress_bind_address"`
}

type VolumePolicy struct {
	AllowedHostPaths []string `yaml:"allowed_host_paths"`
	MaxVolumeCount   int      `yaml:"max_volume_count"`
}

type ImagePolicy struct {
	AllowedRegistries []string `yaml:"allowed_registries"`
	DenyTags          []string `yaml:"deny_tags"`
}

type CapabilityPolicy struct {
	Allowed []string `yaml:"allowed"`
}

type IngressPolicy struct {
	MaxRoutes    int              `yaml:"max_routes"`
	Domains      DomainPolicy     `yaml:"domains"`
	TLS          TLSPolicy        `yaml:"tls"`
	Upstreams    UpstreamPolicy   `yaml:"upstreams"`
	Headers      HeaderPolicy     `yaml:"headers"`
	RateLimiting RateLimitPolicy  `yaml:"rate_limiting"`
	Middleware   MiddlewarePolicy `yaml:"middleware"`
}

type DomainPolicy struct {
	Allowed []string `yaml:"allowed"`
	Denied  []string `yaml:"denied"`
}

type TLSPolicy struct {
	AcmeChallenge    string `yaml:"acme_challenge"`
	AcmeProvider     string `yaml:"acme_provider"`
	AllowCustomCerts bool   `yaml:"allow_custom_certs"`
	MinTLSVersion    string `yaml:"min_tls_version"`
}

type UpstreamPolicy struct {
	AllowedTargets []string `yaml:"allowed_targets"`
	DenyTargets    []string `yaml:"deny_targets"`
}

type HeaderPolicy struct {
	ForceHSTS          bool `yaml:"force_hsts"`
	ForceXSSProtection bool `yaml:"force_xss_protection"`
	AllowCustomHeaders bool `yaml:"allow_custom_headers"`
}

type RateLimitPolicy struct {
	Enabled    bool `yaml:"enabled"`
	DefaultRps int  `yaml:"default_rps"`
	MaxRps     int  `yaml:"max_rps"`
}

type MiddlewarePolicy struct {
	Allowed []string `yaml:"allowed"`
	Denied  []string `yaml:"denied"`
}

// ── Database Policy ─────────────────────────────────────

type DbPolicy struct {
	// Cross-database limits
	MaxDatabases    int `yaml:"max_databases"`
	MaxTotalSizeMb  int `yaml:"max_total_size_mb"`
	MaxTotalConns   int `yaml:"max_total_connections"`

	// Per-database limits
	PerDatabase PerDatabaseLimits `yaml:"per_database"`

	// Role settings bounds
	RoleLimits RoleLimitBounds `yaml:"role_limits"`

	// Password policy
	Password PasswordPolicy `yaml:"password"`

	// Username policy
	Username UsernamePolicy `yaml:"username"`

	// Extension allowlist
	Extensions ExtensionPolicy `yaml:"extensions"`

	// Access control
	Access DbAccessPolicy `yaml:"access"`
}

type PerDatabaseLimits struct {
	MaxSizeMb          int `yaml:"max_size_mb"`
	MaxConnectionLimit int `yaml:"max_connection_limit"`
	MaxRoles           int `yaml:"max_roles"`
}

type RoleLimitBounds struct {
	MaxWorkMem          string `yaml:"max_work_mem"`
	MaxTempFileLimit    string `yaml:"max_temp_file_limit"`
	MinStatementTimeout string `yaml:"min_statement_timeout"`
	MaxStatementTimeout string `yaml:"max_statement_timeout"`
}

type PasswordPolicy struct {
	MinLength              int  `yaml:"min_length"`
	RequireUppercase       bool `yaml:"require_uppercase"`
	RequireLowercase       bool `yaml:"require_lowercase"`
	RequireDigit           bool `yaml:"require_digit"`
	RequireSpecial         bool `yaml:"require_special"`
	DenyUsernameInPassword bool `yaml:"deny_username_in_password"`
}

type UsernamePolicy struct {
	DeniedNames    []string `yaml:"denied_names"`
	DeniedPrefixes []string `yaml:"denied_prefixes"`
	RequiredPrefix string   `yaml:"required_prefix"`
	MaxLength      int      `yaml:"max_length"`
}

type ExtensionPolicy struct {
	Allowed []string `yaml:"allowed"`
}

type DbAccessPolicy struct {
	AllowedHosts []string `yaml:"allowed_hosts"`
}

// ClientStore manages loading and watching client policy files.
type ClientStore struct {
	dir     string
	logger  *slog.Logger
	mu      sync.RWMutex
	clients map[string]*ClientPolicy
}

func NewClientStore(dir string, logger *slog.Logger) (*ClientStore, error) {
	store := &ClientStore{
		dir:     dir,
		logger:  logger,
		clients: make(map[string]*ClientPolicy),
	}
	if err := store.loadAll(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *ClientStore) Get(name string) *ClientPolicy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.clients[name]
}

func (s *ClientStore) loadAll() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("reading clients dir: %w", err)
	}

	clients := make(map[string]*ClientPolicy)
	for _, entry := range entries {
		if entry.IsDir() || (!strings.HasSuffix(entry.Name(), ".yaml") && !strings.HasSuffix(entry.Name(), ".yml")) {
			continue
		}
		policy, err := loadClientPolicy(filepath.Join(s.dir, entry.Name()))
		if err != nil {
			s.logger.Error("failed to load client policy", "file", entry.Name(), "error", err)
			continue
		}
		clients[policy.Client] = policy
		s.logger.Info("loaded client policy", "client", policy.Client)
	}

	s.mu.Lock()
	s.clients = clients
	s.mu.Unlock()

	return nil
}

// Watch polls the clients directory for changes and reloads policies.
func (s *ClientStore) Watch() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if err := s.loadAll(); err != nil {
			s.logger.Error("failed to reload client policies", "error", err)
		}
	}
}

func loadClientPolicy(path string) (*ClientPolicy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading client policy: %w", err)
	}

	policy := &ClientPolicy{}
	if err := yaml.Unmarshal(data, policy); err != nil {
		return nil, fmt.Errorf("parsing client policy: %w", err)
	}

	if policy.Client == "" {
		return nil, fmt.Errorf("client name is required in %s", path)
	}

	return policy, nil
}
