package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/opsen/agent/internal/config"
)

func TestAccessRolesIntegration(t *testing.T) {
	dsn := os.Getenv("OPSEN_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set OPSEN_TEST_POSTGRES_DSN to a disposable PostgreSQL admin URL")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	exec := func(conn *sql.DB, q string) {
		t.Helper()
		if _, err := conn.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	database, owner := "lease_db_"+suffix, "lease_owner_"+suffix
	exec(admin, "CREATE ROLE "+pq.QuoteIdentifier(owner)+" LOGIN PASSWORD 'OwnerPassword-0123456789'")
	defer admin.Exec("DROP ROLE " + pq.QuoteIdentifier(owner))
	exec(admin, "CREATE DATABASE "+pq.QuoteIdentifier(database)+" OWNER "+pq.QuoteIdentifier(owner))
	defer admin.Exec("DROP DATABASE " + pq.QuoteIdentifier(database) + " WITH (FORCE)")
	exec(admin, "REVOKE CONNECT ON DATABASE "+pq.QuoteIdentifier(database)+" FROM PUBLIC")
	connect := func(role, password string) *sql.DB {
		copy := *u
		copy.Path = "/" + database
		copy.User = url.UserPassword(role, password)
		conn, err := sql.Open("postgres", copy.String())
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	ownerConn := connect(owner, "OwnerPassword-0123456789")
	defer ownerConn.Close()
	exec(ownerConn, "CREATE SCHEMA app")
	exec(ownerConn, "CREATE SCHEMA hidden")
	exec(ownerConn, "CREATE TABLE app.records (id bigserial PRIMARY KEY, value text)")
	exec(ownerConn, "CREATE TABLE hidden.private_data (value text)")
	exec(ownerConn, "INSERT INTO app.records(value) VALUES ('initial')")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tracker := NewResourceTracker(filepath.Join(t.TempDir(), "state.json"), logger)
	tracker.Set("tenant", "app", &DatabaseRecord{DatabaseName: database, OwnerRole: owner})
	passwordFile := filepath.Join(t.TempDir(), "pg-password")
	adminPassword, _ := u.User.Password()
	if err := os.WriteFile(passwordFile, []byte(adminPassword), 0600); err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	pg := &PgManager{db: admin, cfg: &config.DbRoleConfig{Host: u.Hostname(), Port: port, AdminUser: u.User.Username(), AdminPasswordFile: passwordFile, SSLMode: u.Query().Get("sslmode")}, logger: logger}
	h := &Handler{pg: pg, tracker: tracker, logger: logger}
	client := &config.ClientPolicy{Client: "tenant", Db: &config.DbPolicy{Password: config.PasswordPolicy{MinLength: 16}}}
	expiry := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	roles := []string{}
	defer func() {
		for _, role := range roles {
			admin.Exec("ALTER ROLE " + pq.QuoteIdentifier(role) + " NOLOGIN")
			admin.Exec("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1", role)
		}
		ownerConn.Close()
		admin.Exec("DROP DATABASE " + pq.QuoteIdentifier(database) + " WITH (FORCE)")
		for _, role := range roles {
			admin.Exec("DROP ROLE IF EXISTS " + pq.QuoteIdentifier(role))
		}
	}()
	create := func(label, mode string, schemas ...string) (string, string) {
		role := "lease_" + label + "_" + suffix
		roles = append(roles, role)
		body := accessBody(mode, expiry, schemas...)
		response := accessRequest(h, client, "PUT", role, body)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		for _, secret := range []string{"RandomLeasePassword", "fingerprint", "marker"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("secret leaked")
			}
		}
		return role, body
	}
	reader, readerBody := create("read", "read", "app")
	readerConn := connect(reader, "RandomLeasePassword-0123456789")
	defer readerConn.Close()
	if err := readerConn.Ping(); err != nil {
		t.Fatal(err)
	}
	wrong := connect(reader, "WrongPassword-0123456789")
	if err := wrong.Ping(); err == nil {
		t.Fatal("test server must require password authentication")
	}
	wrong.Close()
	var count int
	if err := readerConn.QueryRow("SELECT count(*) FROM app.records").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	for _, q := range []string{"INSERT INTO app.records(value) VALUES ('bad')", "SELECT * FROM hidden.private_data", "SELECT nextval('app.records_id_seq')", "CREATE TABLE app.forbidden (id int)", "TRUNCATE app.records"} {
		if _, err := readerConn.Exec(q); err == nil {
			t.Fatal("unexpected permission", q)
		}
	}
	exec(ownerConn, "CREATE TABLE app.future_table (value text)")
	exec(ownerConn, "INSERT INTO app.future_table VALUES ('future')")
	if err := readerConn.QueryRow("SELECT count(*) FROM app.future_table").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	// Replay after a SQL commit but before durable activation must recover safely.
	saved := *tracker.GetDatabase("tenant", "app").AccessRoles[reader]
	saved.Status = "provisioning"
	if err := tracker.setAccessRole("tenant", "app", reader, &saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadResourceTracker(tracker.path, logger)
	if err != nil {
		t.Fatal(err)
	}
	h.tracker = loaded
	tracker = loaded
	if response := accessRequest(h, client, "PUT", reader, readerBody); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if response := accessRequest(h, client, "PUT", reader, accessBody("readwrite", expiry, "app")); response.Code != 409 {
		t.Fatal(response.Code)
	}
	if response := accessRequest(h, client, "PUT", reader, accessBody("read", time.Now().Add(2*time.Hour).UTC().Format(time.RFC3339), "app")); response.Code != 409 {
		t.Fatal(response.Code)
	}
	writer, _ := create("write", "readwrite", "app")
	writerConn := connect(writer, "RandomLeasePassword-0123456789")
	defer writerConn.Close()
	exec(writerConn, "INSERT INTO app.records(value) VALUES ('write')")
	exec(writerConn, "UPDATE app.records SET value='updated' WHERE value='write'")
	exec(writerConn, "DELETE FROM app.records WHERE value='updated'")
	exec(writerConn, "INSERT INTO app.future_table VALUES ('writer')")
	for _, q := range []string{"CREATE TABLE app.forbidden (id int)", "TRUNCATE app.records", "DROP TABLE app.records", "SELECT * FROM hidden.private_data"} {
		if _, err := writerConn.Exec(q); err == nil {
			t.Fatal("unexpected write privilege", q)
		}
	}
	session, err := readerConn.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	var pid int
	if err := session.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	// Cleanup failure leaves login disabled and sessions closed; retry finishes.
	pg.cfg.AdminPasswordFile = "/missing-password-file"
	if response := accessRequest(h, client, "DELETE", reader, ""); response.Code != 500 {
		t.Fatal(response.Code)
	}
	var login bool
	if err := admin.QueryRow("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", reader).Scan(&login); err != nil || login {
		t.Fatal(login, err)
	}
	if err := session.PingContext(context.Background()); err == nil {
		t.Fatal("existing session survived revocation")
	}
	pg.cfg.AdminPasswordFile = passwordFile
	if response := accessRequest(h, client, "DELETE", reader, ""); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if response := accessRequest(h, client, "DELETE", reader, ""); response.Code != 200 {
		t.Fatal(response.Code)
	}
	if response := accessRequest(h, client, "PUT", reader, readerBody); response.Code != 409 {
		t.Fatal(response.Code)
	}
	// Invalid schema grants roll back the complete role creation.
	bad := "lease_bad_" + suffix
	roles = append(roles, bad)
	if response := accessRequest(h, client, "PUT", bad, accessBody("read", expiry, "missing")); response.Code != 500 {
		t.Fatal(response.Code)
	}
	if err := admin.QueryRow("SELECT count(*) FROM pg_roles WHERE rolname=$1", bad).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	if response := accessRequest(h, client, "DELETE", bad, ""); response.Code != 200 {
		t.Fatal(response.Code)
	}
	// PUBLIC grants are additive, so fail closed when they widen the scope.
	exec(ownerConn, "GRANT SELECT ON hidden.private_data TO PUBLIC")
	unsafe := "lease_unsafe_" + suffix
	roles = append(roles, unsafe)
	if response := accessRequest(h, client, "PUT", unsafe, accessBody("read", expiry, "app")); response.Code != 500 {
		t.Fatal(response.Code)
	}
	exec(ownerConn, "REVOKE SELECT ON hidden.private_data FROM PUBLIC")
	if response := accessRequest(h, client, "DELETE", unsafe, ""); response.Code != 200 {
		t.Fatal(response.Code)
	}
	// Password expiration itself prevents new logins even before the controller revokes.
	expired := "lease_expiry_" + suffix
	roles = append(roles, expired)
	deadline := time.Now().Add(2 * time.Second).UTC().Format(time.RFC3339)
	if response := accessRequest(h, client, "PUT", expired, accessBody("read", deadline, "app")); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	expiredConn := connect(expired, "RandomLeasePassword-0123456789")
	if err := expiredConn.Ping(); err != nil {
		t.Fatal(err)
	}
	expiredConn.Close()
	until, _ := time.Parse(time.RFC3339, deadline)
	time.Sleep(time.Until(until) + 100*time.Millisecond)
	expiredConn = connect(expired, "RandomLeasePassword-0123456789")
	if err := expiredConn.Ping(); err == nil {
		t.Fatal("expired password accepted")
	}
	expiredConn.Close()
	if response := accessRequest(h, client, "DELETE", expired, ""); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if response := accessRequest(h, client, "DELETE", writer, ""); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	// Inspect the persisted record: no plaintext credentials, and revocation survives restart.
	data, err := os.ReadFile(tracker.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "RandomLeasePassword") {
		t.Fatal("persisted plaintext password")
	}
	var view map[string]any
	response := accessRequest(h, client, "GET", reader, "")
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil || view["status"] != "revoked" {
		t.Fatal(fmt.Sprint(view), err)
	}
}
