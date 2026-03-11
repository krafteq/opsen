package db

import (
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/opsen/agent/internal/config"
	_ "github.com/lib/pq"
)

// PgManager handles all direct PostgreSQL operations.
type PgManager struct {
	db     *sql.DB
	cfg    *config.DbRoleConfig
	logger *slog.Logger
}

func NewPgManager(cfg *config.DbRoleConfig, logger *slog.Logger) (*PgManager, error) {
	password, err := readPasswordFile(cfg.AdminPasswordFile)
	if err != nil {
		return nil, fmt.Errorf("reading admin password: %w", err)
	}

	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=postgres sslmode=%s",
		cfg.Host, cfg.Port, cfg.AdminUser, password, cfg.SSLMode)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening postgres connection: %w", err)
	}

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("pinging postgres: %w", err)
	}

	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)

	return &PgManager{db: db, cfg: cfg, logger: logger}, nil
}

func (p *PgManager) Close() {
	p.db.Close()
}

// ── Role Operations ─────────────────────────────────────

type RoleOptions struct {
	Password        string
	ConnectionLimit int
}

func (p *PgManager) CreateRole(name string, opts RoleOptions) error {
	if !isValidIdentifier(name) {
		return fmt.Errorf("invalid role name: %s", name)
	}

	connLimit := ""
	if opts.ConnectionLimit > 0 {
		connLimit = fmt.Sprintf(" CONNECTION LIMIT %d", opts.ConnectionLimit)
	}

	// Use SET password_encryption to ensure SCRAM-SHA-256
	_, err := p.db.Exec("SET password_encryption = 'scram-sha-256'")
	if err != nil {
		return fmt.Errorf("setting password encryption: %w", err)
	}

	query := fmt.Sprintf(
		"CREATE ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %s%s",
		quoteIdent(name), quoteLiteral(opts.Password), connLimit,
	)
	_, err = p.db.Exec(query)
	if err != nil {
		return fmt.Errorf("creating role %s: %w", name, err)
	}

	return nil
}

func (p *PgManager) DropRole(name string) error {
	if !isValidIdentifier(name) {
		return fmt.Errorf("invalid role name: %s", name)
	}

	// Terminate any active connections for this role
	_, _ = p.db.Exec(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1",
		name,
	)

	_, err := p.db.Exec(fmt.Sprintf("DROP ROLE IF EXISTS %s", quoteIdent(name)))
	if err != nil {
		return fmt.Errorf("dropping role %s: %w", name, err)
	}
	return nil
}

func (p *PgManager) SetRoleParam(roleName, param, value string) error {
	if !isValidIdentifier(roleName) || !isValidGUCParam(param) {
		return fmt.Errorf("invalid role name or parameter")
	}

	query := fmt.Sprintf("ALTER ROLE %s SET %s = %s",
		quoteIdent(roleName), param, quoteLiteral(value))
	_, err := p.db.Exec(query)
	if err != nil {
		return fmt.Errorf("setting %s on role %s: %w", param, roleName, err)
	}
	return nil
}

func (p *PgManager) AlterRoleConnectionLimit(roleName string, limit int) error {
	if !isValidIdentifier(roleName) {
		return fmt.Errorf("invalid role name: %s", roleName)
	}
	_, err := p.db.Exec(fmt.Sprintf("ALTER ROLE %s CONNECTION LIMIT %d", quoteIdent(roleName), limit))
	return err
}

// ── Database Operations ─────────────────────────────────

func (p *PgManager) CreateDatabase(name, owner string, connLimit int) error {
	if !isValidIdentifier(name) || !isValidIdentifier(owner) {
		return fmt.Errorf("invalid database or owner name")
	}

	encoding := p.cfg.DefaultEncoding
	if encoding == "" {
		encoding = "UTF8"
	}
	locale := p.cfg.DefaultLocale
	if locale == "" {
		locale = "en_US.UTF-8"
	}

	connLimitClause := ""
	if connLimit > 0 {
		connLimitClause = fmt.Sprintf(" CONNECTION LIMIT %d", connLimit)
	}

	query := fmt.Sprintf(
		"CREATE DATABASE %s OWNER %s ENCODING '%s' LC_COLLATE '%s' LC_CTYPE '%s'%s",
		quoteIdent(name), quoteIdent(owner), encoding, locale, locale, connLimitClause,
	)
	_, err := p.db.Exec(query)
	if err != nil {
		return fmt.Errorf("creating database %s: %w", name, err)
	}

	// Revoke public connect — only owner and explicitly granted roles can connect
	_, err = p.db.Exec(fmt.Sprintf("REVOKE CONNECT ON DATABASE %s FROM PUBLIC", quoteIdent(name)))
	if err != nil {
		p.logger.Warn("failed to revoke public connect", "database", name, "error", err)
	}

	return nil
}

func (p *PgManager) DropDatabase(name string) error {
	if !isValidIdentifier(name) {
		return fmt.Errorf("invalid database name: %s", name)
	}

	// Terminate all connections to the database
	_, _ = p.db.Exec(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
		name,
	)

	_, err := p.db.Exec(fmt.Sprintf("DROP DATABASE IF EXISTS %s", quoteIdent(name)))
	if err != nil {
		return fmt.Errorf("dropping database %s: %w", name, err)
	}
	return nil
}

func (p *PgManager) AlterDatabaseConnectionLimit(name string, limit int) error {
	if !isValidIdentifier(name) {
		return fmt.Errorf("invalid database name: %s", name)
	}
	_, err := p.db.Exec(fmt.Sprintf("ALTER DATABASE %s CONNECTION LIMIT %d", quoteIdent(name), limit))
	return err
}

func (p *PgManager) CreateExtension(dbName, extName string) error {
	if !isValidIdentifier(dbName) || !isValidExtensionName(extName) {
		return fmt.Errorf("invalid database or extension name")
	}

	// Connect to the specific database to create extension
	password, err := readPasswordFile(p.cfg.AdminPasswordFile)
	if err != nil {
		return err
	}

	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		p.cfg.Host, p.cfg.Port, p.cfg.AdminUser, password, dbName, p.cfg.SSLMode)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("connecting to %s: %w", dbName, err)
	}
	defer db.Close()

	_, err = db.Exec(fmt.Sprintf("CREATE EXTENSION IF NOT EXISTS %s", quoteIdent(extName)))
	if err != nil {
		return fmt.Errorf("creating extension %s in %s: %w", extName, dbName, err)
	}
	return nil
}

// ── Grant/Revoke ────────────────────────────────────────

func (p *PgManager) GrantConnect(dbName, roleName string) error {
	if !isValidIdentifier(dbName) || !isValidIdentifier(roleName) {
		return fmt.Errorf("invalid database or role name")
	}
	_, err := p.db.Exec(fmt.Sprintf("GRANT CONNECT ON DATABASE %s TO %s", quoteIdent(dbName), quoteIdent(roleName)))
	return err
}

func (p *PgManager) RevokeConnect(dbName, roleName string) error {
	if !isValidIdentifier(dbName) || !isValidIdentifier(roleName) {
		return fmt.Errorf("invalid database or role name")
	}

	// Terminate active connections for this role to this database
	_, _ = p.db.Exec(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = $2",
		dbName, roleName,
	)

	_, err := p.db.Exec(fmt.Sprintf("REVOKE CONNECT ON DATABASE %s FROM %s", quoteIdent(dbName), quoteIdent(roleName)))
	return err
}

func (p *PgManager) GrantReadOnly(dbName, roleName, ownerRole string) error {
	// Connect to the specific database
	password, err := readPasswordFile(p.cfg.AdminPasswordFile)
	if err != nil {
		return err
	}

	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		p.cfg.Host, p.cfg.Port, p.cfg.AdminUser, password, dbName, p.cfg.SSLMode)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("connecting to %s: %w", dbName, err)
	}
	defer db.Close()

	// Grant usage on all schemas owned by the owner, then select on all tables
	queries := []string{
		fmt.Sprintf("GRANT USAGE ON SCHEMA public TO %s", quoteIdent(roleName)),
		fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %s GRANT SELECT ON TABLES TO %s",
			quoteIdent(ownerRole), quoteIdent(roleName)),
		fmt.Sprintf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO %s", quoteIdent(roleName)),
	}

	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("executing grant: %w", err)
		}
	}

	return nil
}

// RevokeAllPrivileges revokes all grants for a role in a specific database,
// including default privileges, so the role can be dropped cleanly.
func (p *PgManager) RevokeAllPrivileges(dbName, roleName, ownerRole string) error {
	password, err := readPasswordFile(p.cfg.AdminPasswordFile)
	if err != nil {
		return err
	}

	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		p.cfg.Host, p.cfg.Port, p.cfg.AdminUser, password, dbName, p.cfg.SSLMode)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("connecting to %s: %w", dbName, err)
	}
	defer db.Close()

	queries := []string{
		fmt.Sprintf("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %s", quoteIdent(roleName)),
		fmt.Sprintf("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %s", quoteIdent(roleName)),
		fmt.Sprintf("REVOKE USAGE ON SCHEMA public FROM %s", quoteIdent(roleName)),
	}

	if ownerRole != "" {
		queries = append(queries,
			fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %s REVOKE ALL ON TABLES FROM %s",
				quoteIdent(ownerRole), quoteIdent(roleName)),
		)
	}

	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			p.logger.Warn("revoke privilege failed", "query", q, "error", err)
		}
	}

	return nil
}

// RevokeConnectFromOwner blocks the owner from creating new connections.
// Used for quota enforcement.
func (p *PgManager) RevokeConnectFromOwner(dbName, ownerRole string) error {
	if !isValidIdentifier(dbName) || !isValidIdentifier(ownerRole) {
		return fmt.Errorf("invalid identifiers")
	}
	_, err := p.db.Exec(fmt.Sprintf("REVOKE CONNECT ON DATABASE %s FROM %s", quoteIdent(dbName), quoteIdent(ownerRole)))
	return err
}

// RestoreConnectToOwner restores the owner's connect privilege.
func (p *PgManager) RestoreConnectToOwner(dbName, ownerRole string) error {
	if !isValidIdentifier(dbName) || !isValidIdentifier(ownerRole) {
		return fmt.Errorf("invalid identifiers")
	}
	_, err := p.db.Exec(fmt.Sprintf("GRANT CONNECT ON DATABASE %s TO %s", quoteIdent(dbName), quoteIdent(ownerRole)))
	return err
}

// ── Monitoring Queries ──────────────────────────────────

func (p *PgManager) DatabaseSizeMb(dbName string) (int, error) {
	var sizeBytes int64
	err := p.db.QueryRow("SELECT pg_database_size($1)", dbName).Scan(&sizeBytes)
	if err != nil {
		return 0, err
	}
	return int(sizeBytes / (1024 * 1024)), nil
}

func (p *PgManager) ActiveConnections(dbName string) (int, error) {
	var count int
	err := p.db.QueryRow(
		"SELECT count(*) FROM pg_stat_activity WHERE datname = $1",
		dbName,
	).Scan(&count)
	return count, err
}

// RoleExists checks if a role already exists.
func (p *PgManager) RoleExists(name string) (bool, error) {
	var exists bool
	err := p.db.QueryRow("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1)", name).Scan(&exists)
	return exists, err
}

// DatabaseExists checks if a database already exists.
func (p *PgManager) DatabaseExists(name string) (bool, error) {
	var exists bool
	err := p.db.QueryRow("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists)
	return exists, err
}

// ── Helpers ─────────────────────────────────────────────

func readPasswordFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// quoteIdent safely quotes a SQL identifier to prevent injection.
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// quoteLiteral safely quotes a SQL string literal.
func quoteLiteral(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}

// isValidIdentifier checks that a name is safe for use as a SQL identifier.
func isValidIdentifier(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for i, c := range s {
		if c >= 'a' && c <= 'z' {
			continue
		}
		if c >= '0' && c <= '9' && i > 0 {
			continue
		}
		if c == '_' {
			continue
		}
		return false
	}
	return true
}

// isValidExtensionName checks that an extension name is safe (allows hyphens).
func isValidExtensionName(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for i, c := range s {
		if c >= 'a' && c <= 'z' {
			continue
		}
		if c >= '0' && c <= '9' && i > 0 {
			continue
		}
		if c == '_' || c == '-' {
			continue
		}
		return false
	}
	return true
}

// isValidGUCParam checks that a parameter name is a valid GUC name.
func isValidGUCParam(s string) bool {
	allowed := map[string]bool{
		"statement_timeout":                    true,
		"work_mem":                             true,
		"temp_file_limit":                      true,
		"idle_in_transaction_session_timeout":   true,
		"maintenance_work_mem":                 true,
		"temp_buffers":                         true,
		"log_statement":                        true,
		"log_min_duration_statement":           true,
	}
	return allowed[s]
}
