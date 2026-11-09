package db

import (
	"database/sql"
	"fmt"
	"github.com/lib/pq"
	"net/url"
	"strconv"
	"time"
)

func (p *PgManager) accessDatabase(database string) (*sql.DB, error) {
	if !isValidIdentifier(database) {
		return nil, fmt.Errorf("invalid database")
	}
	password, err := readPasswordFile(p.cfg.AdminPasswordFile)
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "postgres", Host: p.cfg.Host + ":" + strconv.Itoa(p.cfg.Port), Path: "/" + database, User: url.UserPassword(p.cfg.AdminUser, password)}
	q := u.Query()
	q.Set("sslmode", p.cfg.SSLMode)
	q.Set("connect_timeout", "5")
	q.Set("statement_timeout", "10000")
	u.RawQuery = q.Encode()
	conn, err := sql.Open("postgres", u.String())
	if err == nil {
		conn.SetMaxOpenConns(1)
	}
	return conn, err
}

func roleMarker(db *sql.DB, role string) (string, bool, error) {
	var marker string
	err := db.QueryRow("SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname=$1", role).Scan(&marker)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return marker, err == nil, err
}

func (p *PgManager) ProvisionAccessRole(database, owner string, lease *AccessRoleRecord, password string) error {
	conn, err := p.accessDatabase(database)
	if err != nil {
		return err
	}
	defer conn.Close()
	marker, exists, err := roleMarker(conn, lease.Role)
	if err != nil {
		return err
	}
	if exists {
		if marker != lease.Marker {
			return fmt.Errorf("role ownership mismatch")
		}
		// Role marker, grants and LOGIN are committed in a single SQL transaction.
		return nil
	}
	expiry, err := time.Parse(time.RFC3339, lease.ExpiresAt)
	if err != nil || !expiry.After(time.Now()) {
		return fmt.Errorf("access role has expired")
	}
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	exec := func(query string) error { _, err := tx.Exec(query); return err }
	if err := exec("SET LOCAL password_encryption = 'scram-sha-256'"); err != nil {
		return err
	}
	role := pq.QuoteIdentifier(lease.Role)
	if err := exec(fmt.Sprintf("CREATE ROLE %s NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %s VALID UNTIL %s", role, pq.QuoteLiteral(password), pq.QuoteLiteral(lease.ExpiresAt))); err != nil {
		return err
	}
	if err := exec(fmt.Sprintf("COMMENT ON ROLE %s IS %s", role, pq.QuoteLiteral(lease.Marker))); err != nil {
		return err
	}
	if err := exec(fmt.Sprintf("GRANT CONNECT ON DATABASE %s TO %s", pq.QuoteIdentifier(database), role)); err != nil {
		return err
	}
	tables, sequences := "SELECT", "SELECT"
	if lease.AccessMode == "readwrite" {
		tables = "SELECT, INSERT, UPDATE, DELETE"
		sequences = "USAGE, SELECT"
	}
	for _, schema := range lease.Schemas {
		var allowed bool
		err := tx.QueryRow(`SELECT n.nspowner = r.oid OR (n.nspname = 'public' AND pg_get_userbyid(n.nspowner) = 'pg_database_owner' AND d.datdba = r.oid)
   FROM pg_namespace n JOIN pg_roles r ON r.rolname=$2 JOIN pg_database d ON d.datname=current_database() WHERE n.nspname=$1`, schema, owner).Scan(&allowed)
		if err != nil || !allowed {
			return fmt.Errorf("schema must exist and belong to the database owner")
		}
		quoted := pq.QuoteIdentifier(schema)
		for _, query := range []string{
			fmt.Sprintf("GRANT USAGE ON SCHEMA %s TO %s", quoted, role),
			fmt.Sprintf("GRANT %s ON ALL TABLES IN SCHEMA %s TO %s", tables, quoted, role),
			fmt.Sprintf("GRANT %s ON ALL SEQUENCES IN SCHEMA %s TO %s", sequences, quoted, role),
			fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA %s GRANT %s ON TABLES TO %s", pq.QuoteIdentifier(owner), quoted, tables, role),
			fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA %s GRANT %s ON SEQUENCES TO %s", pq.QuoteIdentifier(owner), quoted, sequences, role),
		} {
			if err := exec(query); err != nil {
				return err
			}
		}
	}
	// PostgreSQL privileges are additive. Refuse existing PUBLIC grants that
	// defeat the selected data/schema scope; do not change other users' grants.
	var unsafe bool
	err = tx.QueryRow(`SELECT has_database_privilege($1,current_database(),'CREATE') OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND has_schema_privilege($1,n.oid,'CREATE'))
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND
   ((NOT(n.nspname = ANY($2)) AND has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR
    ($3='read' AND has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR has_table_privilege($1,c.oid,'TRUNCATE,REFERENCES,TRIGGER')))
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND ((NOT(n.nspname = ANY($2)) AND has_sequence_privilege($1,c.oid,'SELECT,USAGE,UPDATE')) OR ($3='read' AND has_sequence_privilege($1,c.oid,'USAGE,UPDATE')) OR has_sequence_privilege($1,c.oid,'UPDATE')))
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND has_function_privilege($1,p.oid,'EXECUTE'))
  OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datallowconn AND NOT d.datistemplate AND d.datname NOT IN (current_database(),'postgres') AND has_database_privilege($1,d.oid,'CONNECT'))`, lease.Role, pq.Array(lease.Schemas), lease.AccessMode).Scan(&unsafe)
	if err != nil {
		return err
	}
	if unsafe {
		return fmt.Errorf("PUBLIC privileges defeat requested access scope")
	}
	if err := exec(fmt.Sprintf("ALTER ROLE %s LOGIN", role)); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *PgManager) RevokeAccessRole(database, owner string, lease *AccessRoleRecord) error {
	// Commit NOLOGIN before termination and cleanup. Failures remain disabled.
	marker, exists, err := roleMarker(p.db, lease.Role)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if marker != lease.Marker {
		return fmt.Errorf("role ownership mismatch")
	}
	role := pq.QuoteIdentifier(lease.Role)
	if _, err := p.db.Exec(fmt.Sprintf("ALTER ROLE %s NOLOGIN PASSWORD NULL", role)); err != nil {
		return err
	}
	rows, err := p.db.Query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid <> pg_backend_pid()", lease.Role)
	if err != nil {
		return err
	}
	terminated := true
	for rows.Next() {
		var ok bool
		if err := rows.Scan(&ok); err != nil {
			rows.Close()
			return err
		}
		terminated = terminated && ok
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !terminated {
		return fmt.Errorf("could not terminate every role session")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var count int
		if err := p.db.QueryRow("SELECT count(*) FROM pg_stat_activity WHERE usename=$1", lease.Role).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("role sessions still active")
		}
		time.Sleep(25 * time.Millisecond)
	}
	conn, err := p.accessDatabase(database)
	if err != nil {
		return err
	}
	defer conn.Close()
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, schema := range lease.Schemas {
		var exists bool
		if err := tx.QueryRow("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1)", schema).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			continue
		}
		quoted := pq.QuoteIdentifier(schema)
		for _, query := range []string{
			fmt.Sprintf("REVOKE ALL ON ALL TABLES IN SCHEMA %s FROM %s", quoted, role),
			fmt.Sprintf("REVOKE ALL ON ALL SEQUENCES IN SCHEMA %s FROM %s", quoted, role),
			fmt.Sprintf("REVOKE ALL ON SCHEMA %s FROM %s", quoted, role),
			fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA %s REVOKE ALL ON TABLES FROM %s", pq.QuoteIdentifier(owner), quoted, role),
			fmt.Sprintf("ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA %s REVOKE ALL ON SEQUENCES FROM %s", pq.QuoteIdentifier(owner), quoted, role),
		} {
			if _, err := tx.Exec(query); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(fmt.Sprintf("REVOKE ALL ON DATABASE %s FROM %s", pq.QuoteIdentifier(database), role)); err != nil {
		return err
	}
	// Never DROP OWNED: unexpected ownership must not delete application data.
	if _, err := tx.Exec(fmt.Sprintf("DROP ROLE %s", role)); err != nil {
		return err
	}
	return tx.Commit()
}
