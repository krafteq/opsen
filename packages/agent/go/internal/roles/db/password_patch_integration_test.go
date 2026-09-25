package db

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/opsen/agent/internal/config"
)

// Run against a disposable PostgreSQL server with TCP password authentication:
// OPSEN_TEST_POSTGRES_DSN=postgres://postgres:secret@127.0.0.1:5432/postgres?sslmode=disable go test ./internal/roles/db -run Integration
func TestPasswordPatchIntegration(t *testing.T) {
	dsn := os.Getenv("OPSEN_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set OPSEN_TEST_POSTGRES_DSN to a disposable PostgreSQL admin URL")
	}
	adminURL, err := url.Parse(dsn)
	if err != nil || (adminURL.Scheme != "postgres" && adminURL.Scheme != "postgresql") {
		t.Fatal("OPSEN_TEST_POSTGRES_DSN must be a PostgreSQL URL")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err := admin.Ping(); err != nil {
		t.Fatal(err)
	}
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	database, role := "patch_db_"+suffix, "patch_owner_"+suffix
	oldPassword, newPassword := "OldPassword-42", `New'\Password-42`
	exec := func(conn *sql.DB, query string) {
		t.Helper()
		if _, err := conn.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	exec(admin, "SET password_encryption = 'scram-sha-256'")
	exec(admin, "CREATE ROLE "+pq.QuoteIdentifier(role)+" LOGIN PASSWORD "+pq.QuoteLiteral(oldPassword))
	defer admin.Exec("DROP ROLE " + pq.QuoteIdentifier(role))
	exec(admin, "CREATE DATABASE "+pq.QuoteIdentifier(database)+" OWNER "+pq.QuoteIdentifier(role)+" CONNECTION LIMIT 12")
	defer admin.Exec("DROP DATABASE " + pq.QuoteIdentifier(database) + " WITH (FORCE)")
	connect := func(password string) (*sql.DB, error) {
		u := *adminURL
		u.User = url.UserPassword(role, password)
		u.Path = "/" + database
		q := u.Query()
		q.Set("connect_timeout", "5")
		q.Del("user")
		q.Del("password")
		q.Del("dbname")
		u.RawQuery = q.Encode()
		conn, err := sql.Open("postgres", u.String())
		if err != nil {
			return nil, err
		}
		if err = conn.Ping(); err != nil {
			conn.Close()
			return nil, err
		}
		return conn, nil
	}
	owner, err := connect(oldPassword)
	if err != nil {
		t.Fatal(err)
	}
	exec(owner, "CREATE TABLE preserved (value text)")
	exec(owner, "INSERT INTO preserved VALUES ('still here')")
	owner.Close()
	// Refuse a trust-authenticated setup: it cannot prove password replacement.
	if unexpected, err := connect("DefinitelyWrongPassword"); err == nil {
		unexpected.Close()
		t.Fatal("integration server must require password authentication")
	}
	var databaseOID, roleOID int64
	if err := admin.QueryRow("SELECT oid FROM pg_database WHERE datname=$1", database).Scan(&databaseOID); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow("SELECT oid FROM pg_roles WHERE rolname=$1", role).Scan(&roleOID); err != nil {
		t.Fatal(err)
	}
	logs := new(bytes.Buffer)
	logger := slog.New(slog.NewTextHandler(logs, nil))
	tracker := NewResourceTracker(filepath.Join(t.TempDir(), "state.json"), logger)
	tracker.Set("tenant", "app", &DatabaseRecord{DatabaseName: database, OwnerRole: role, ConnectionLimit: 12, MaxSizeMb: 256})
	pg := &PgManager{db: admin, logger: logger}
	h := &Handler{pg: pg, tracker: tracker, logger: logger}
	policy := &config.ClientPolicy{Client: "tenant", Db: &config.DbPolicy{Password: config.PasswordPolicy{MinLength: 12}}}
	body, _ := json.Marshal(map[string]any{"owner": map[string]string{"password": newPassword}})
	response := patchRequest(h, policy, string(body))
	if response.Code != 200 {
		t.Fatalf("rotation failed: %d %s", response.Code, response.Body)
	}
	rotated, err := connect(newPassword)
	if err != nil {
		t.Fatalf("new credential cannot authenticate: %v", err)
	}
	var value string
	if err := rotated.QueryRow("SELECT value FROM preserved").Scan(&value); err != nil || value != "still here" {
		t.Fatalf("data lost: value=%q err=%v", value, err)
	}
	rotated.Close()
	if unexpected, err := connect(oldPassword); err == nil {
		unexpected.Close()
		t.Fatal("old credential still authenticates")
	}
	var gotDatabaseOID, gotRoleOID, ownerOID int64
	var limit int
	if err := admin.QueryRow("SELECT oid, datdba, datconnlimit FROM pg_database WHERE datname=$1", database).Scan(&gotDatabaseOID, &ownerOID, &limit); err != nil {
		t.Fatal(err)
	}
	var scram bool
	if err := admin.QueryRow("SELECT oid, rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname=$1", role).Scan(&gotRoleOID, &scram); err != nil {
		t.Fatal(err)
	}
	if gotDatabaseOID != databaseOID || gotRoleOID != roleOID || ownerOID != roleOID || limit != 12 || !scram {
		t.Fatalf("identity/configuration changed or password not SCRAM: database=%d role=%d owner=%d limit=%d scram=%t", gotDatabaseOID, gotRoleOID, ownerOID, limit, scram)
	}
	// A stored verifier must never be accepted as plaintext: PostgreSQL would
	// install it directly and authentication with the supplied string would fail.
	var verifier string
	if err := admin.QueryRow("SELECT rolpassword FROM pg_authid WHERE rolname=$1", role).Scan(&verifier); err != nil {
		t.Fatal(err)
	}
	verifierBody, _ := json.Marshal(map[string]any{"owner": map[string]string{"password": verifier}, "limits": map[string]int{"connection_limit": 25}})
	rejected := patchRequest(h, policy, string(verifierBody))
	if rejected.Code != 400 {
		t.Fatalf("stored verifier accepted: status=%d", rejected.Code)
	}
	preserved, err := connect(newPassword)
	if err != nil {
		t.Fatalf("verifier rejection changed credentials: %v", err)
	}
	preserved.Close()
	state, err := os.ReadFile(tracker.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{rejected.Body.String(), logs.String(), string(state)} {
		if strings.Contains(output, verifier) {
			t.Error("stored verifier leaked")
		}
	}
	// A PostgreSQL-rejected GUC must roll back the preceding connection-limit update.
	rejectedPassword := "RejectedPassword-42"
	err = pg.UpdateDatabase(database, role, &rejectedPassword, 25, map[string]string{"work_mem": "not-a-memory-size"})
	if err == nil {
		t.Fatal("invalid GUC unexpectedly accepted")
	}
	if err := admin.QueryRow("SELECT datconnlimit FROM pg_database WHERE datname=$1", database).Scan(&limit); err != nil {
		t.Fatal(err)
	}
	if limit != 12 {
		t.Fatalf("failed transaction changed connection limit to %d", limit)
	}
	stillValid, err := connect(newPassword)
	if err != nil {
		t.Fatalf("failed transaction changed working password: %v", err)
	}
	stillValid.Close()
	if unexpected, err := connect(rejectedPassword); err == nil {
		unexpected.Close()
		t.Fatal("failed transaction installed rejected password")
	}
}
