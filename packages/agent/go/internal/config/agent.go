package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type AgentConfig struct {
	Listen          string          `yaml:"listen"`
	TLS             TLSConfig       `yaml:"tls"`
	ClientsDir      string          `yaml:"clients_dir"`
	Roles           RolesConfig     `yaml:"roles"`
	GlobalHardening GlobalHardening `yaml:"global_hardening"`
	Deny            DenyRules       `yaml:"deny"`
	Logging         LogConfig       `yaml:"logging"`
	Reload          ReloadConfig    `yaml:"reload"`
}

type TLSConfig struct {
	Cert       string `yaml:"cert"`
	Key        string `yaml:"key"`
	CA         string `yaml:"ca"`
	MinVersion string `yaml:"min_version"`
}

type RolesConfig struct {
	Compose *ComposeRoleConfig `yaml:"compose,omitempty"`
	Ingress *IngressRoleConfig `yaml:"ingress,omitempty"`
	Db      *DbRoleConfig      `yaml:"db,omitempty"`
}

type ComposeRoleConfig struct {
	ComposeBinary  string `yaml:"compose_binary"`
	DeploymentsDir string `yaml:"deployments_dir"`
	NetworkPrefix  string `yaml:"network_prefix"`
	PortRange      string `yaml:"port_range"` // Host port range for exposed container ports, e.g. "8000-8999"
}

type IngressRoleConfig struct {
	Driver        string `yaml:"driver"`
	ConfigDir     string `yaml:"config_dir"`
	ReloadCommand string `yaml:"reload_command,omitempty"`
}

type DbRoleConfig struct {
	Host              string `yaml:"host"`
	Port              int    `yaml:"port"`
	AdminUser         string `yaml:"admin_user"`
	AdminPasswordFile string `yaml:"admin_password_file"`
	DefaultEncoding   string `yaml:"default_encoding"`
	DefaultLocale     string `yaml:"default_locale"`
	SizeCheckInterval int    `yaml:"size_check_interval"`
	SSLMode           string `yaml:"ssl_mode"`
	DataDir           string `yaml:"data_dir"`
}

type GlobalHardening struct {
	NoNewPrivileges bool         `yaml:"no_new_privileges"`
	CapDropAll      bool         `yaml:"cap_drop_all"`
	ReadOnlyRootfs  bool         `yaml:"read_only_rootfs"`
	DefaultUser     string       `yaml:"default_user"`
	DefaultTmpfs    []TmpfsMount `yaml:"default_tmpfs"`
	PidLimit        int          `yaml:"pid_limit"`
}

type TmpfsMount struct {
	Path    string `yaml:"path"`
	Options string `yaml:"options,omitempty"`
}

type DenyRules struct {
	Privileged   bool     `yaml:"privileged"`
	NetworkModes []string `yaml:"network_modes"`
	PidMode      string   `yaml:"pid_mode"`
	IpcMode      string   `yaml:"ipc_mode"`
	HostPaths    []string `yaml:"host_paths"`
}

type LogConfig struct {
	File      string `yaml:"file"`
	AuditFile string `yaml:"audit_file"`
	Level     string `yaml:"level"`
}

type ReloadConfig struct {
	WatchClientsDir bool `yaml:"watch_clients_dir"`
}

func Load(path string) (*AgentConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config file: %w", err)
	}

	cfg := &AgentConfig{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}

	if cfg.Listen == "" {
		return nil, fmt.Errorf("listen address is required")
	}
	if cfg.TLS.Cert == "" || cfg.TLS.Key == "" || cfg.TLS.CA == "" {
		return nil, fmt.Errorf("tls cert, key, and ca are required")
	}
	if cfg.ClientsDir == "" {
		cfg.ClientsDir = "/etc/opsen-agent/clients/"
	}

	return cfg, nil
}
