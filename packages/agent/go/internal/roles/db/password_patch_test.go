package db

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/lib/pq"
	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

func patchFixture(t *testing.T) (*Handler, sqlmock.Sqlmock, *config.ClientPolicy, *bytes.Buffer) {
	t.Helper()
	conn, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn.Close()
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
	})
	logs := new(bytes.Buffer)
	logger := slog.New(slog.NewTextHandler(logs, nil))
	tracker := NewResourceTracker(filepath.Join(t.TempDir(), "state.json"), logger)
	tracker.Set("tenant", "app", &DatabaseRecord{DatabaseName: "app", OwnerRole: "app_owner", ConnectionLimit: 12, MaxSizeMb: 256, Extensions: []string{"pgcrypto"}, AdditionalRoles: []string{"reader"}})
	policy := &config.ClientPolicy{Client: "tenant", Db: &config.DbPolicy{Password: config.PasswordPolicy{MinLength: 12, DenyUsernameInPassword: true}, PerDatabase: config.PerDatabaseLimits{MaxConnectionLimit: 100}}}
	return &Handler{pg: &PgManager{db: conn, logger: logger}, tracker: tracker, logger: logger}, mock, policy, logs
}

func patchRequest(h *Handler, client *config.ClientPolicy, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("PATCH", "/v1/db/databases/app", strings.NewReader(body))
	r.SetPathValue("name", "app")
	if client != nil {
		r = r.WithContext(identity.WithClient(r.Context(), client))
	}
	w := httptest.NewRecorder()
	h.UpdateDatabase(w, r)
	return w
}

func expectPassword(mock sqlmock.Sqlmock, password string) {
	mock.ExpectExec("SET LOCAL password_encryption = 'scram-sha-256'").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`ALTER ROLE "app_owner" PASSWORD ` + pq.QuoteLiteral(password)).WillReturnResult(sqlmock.NewResult(0, 0))
}

func TestPasswordPatchPreservesTrackedConfiguration(t *testing.T) {
	h, mock, policy, logs := patchFixture(t)
	policy.Db.RoleLimits.MinStatementTimeout = "1s" // Password-only must not apply this default.
	before := *h.tracker.GetDatabase("tenant", "app")
	password := `New'\\Password-42`
	body, _ := json.Marshal(map[string]any{"owner": map[string]string{"password": password}})
	mock.ExpectBegin()
	expectPassword(mock, password)
	mock.ExpectCommit()
	w := patchRequest(h, policy, string(body))
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	after := *h.tracker.GetDatabase("tenant", "app")
	after.ModifiedAt = before.ModifiedAt
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("password rotation changed configuration: before=%+v after=%+v", before, after)
	}
	state, err := os.ReadFile(h.tracker.path)
	if err != nil {
		t.Fatal(err)
	}
	for label, output := range map[string]string{"response": w.Body.String(), "logs": logs.String(), "state": string(state)} {
		if strings.Contains(output, password) || strings.Contains(output, "New'") {
			t.Errorf("password leaked in %s", label)
		}
	}
}

func TestPasswordPatchRejectsInvalidRequestsBeforeMutation(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		client     string
	}{
		{"empty", `{}`, 400, "tenant"}, {"empty owner", `{"owner":{}}`, 400, "tenant"},
		{"empty password", `{"owner":{"password":""}}`, 400, "tenant"},
		{"nul", `{"owner":{"password":"LongPassword\u0000Tail"}}`, 400, "tenant"},
		{"short", `{"owner":{"password":"short"},"limits":{"connection_limit":20}}`, 400, "tenant"},
		{"tracked username", `{"owner":{"password":"APP_OWNER-LongPassword"}}`, 400, "tenant"},
		{"limits policy", `{"owner":{"password":"LongPassword-42"},"limits":{"connection_limit":101}}`, 400, "tenant"},
		{"malformed", `{`, 400, "tenant"},
		{"other client", `{"owner":{"password":"LongPassword-42"}}`, 404, "other"},
		{"missing db", `{"owner":{"password":"LongPassword-42"}}`, 404, "missing"},
		{"no identity", `{}`, 403, "nil"}, {"db forbidden", `{}`, 403, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _, policy, _ := patchFixture(t)
			switch tc.client {
			case "nil":
				policy = nil
			case "forbidden":
				policy.Db = nil
			case "missing":
				h.tracker.Remove("tenant", "app")
			default:
				policy.Client = tc.client
			}
			w := patchRequest(h, policy, tc.body)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body)
			}
		})
	}
}

func TestPasswordPatchMixedAndLimitsOnly(t *testing.T) {
	for _, withPassword := range []bool{false, true} {
		t.Run(map[bool]string{false: "limits only", true: "mixed"}[withPassword], func(t *testing.T) {
			h, mock, policy, _ := patchFixture(t)
			body := map[string]any{"limits": map[string]any{"connection_limit": 20, "max_size_mb": 512, "work_mem": "8MB"}}
			mock.ExpectBegin()
			if withPassword {
				body["owner"] = map[string]string{"password": "LongPassword-42"}
			}
			mock.ExpectExec(`ALTER DATABASE "app" CONNECTION LIMIT 20`).WillReturnResult(sqlmock.NewResult(0, 0))
			mock.ExpectExec(`ALTER ROLE "app_owner" SET work_mem = '8MB'`).WillReturnResult(sqlmock.NewResult(0, 0))
			if withPassword {
				expectPassword(mock, "LongPassword-42")
			}
			mock.ExpectCommit()
			encoded, _ := json.Marshal(body)
			w := patchRequest(h, policy, string(encoded))
			if w.Code != 200 {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
			record := h.tracker.GetDatabase("tenant", "app")
			if record.ConnectionLimit != 20 || record.MaxSizeMb != 512 {
				t.Fatalf("limits not tracked: %+v", record)
			}
		})
	}
}

func TestPasswordPatchFailureRollsBackAndRedacts(t *testing.T) {
	for _, stage := range []string{"password", "guc", "commit"} {
		t.Run(stage, func(t *testing.T) {
			h, mock, policy, logs := patchFixture(t)
			before := *h.tracker.GetDatabase("tenant", "app")
			password := "SensitivePassword-42"
			failure := errors.New("database error includes " + password)
			mock.ExpectBegin()
			mock.ExpectExec(`ALTER DATABASE "app" CONNECTION LIMIT 20`).WillReturnResult(sqlmock.NewResult(0, 0))
			guc := mock.ExpectExec(`ALTER ROLE "app_owner" SET work_mem = '8MB'`)
			if stage == "guc" {
				guc.WillReturnError(failure)
			} else {
				guc.WillReturnResult(sqlmock.NewResult(0, 0))
				mock.ExpectExec("SET LOCAL password_encryption = 'scram-sha-256'").WillReturnResult(sqlmock.NewResult(0, 0))
				pass := mock.ExpectExec(`ALTER ROLE "app_owner" PASSWORD 'SensitivePassword-42'`)
				if stage == "password" {
					pass.WillReturnError(failure)
				} else {
					pass.WillReturnResult(sqlmock.NewResult(0, 0))
				}
			}
			if stage == "commit" {
				mock.ExpectCommit().WillReturnError(failure)
			} else {
				mock.ExpectRollback()
			}
			w := patchRequest(h, policy, `{"owner":{"password":"SensitivePassword-42"},"limits":{"connection_limit":20,"max_size_mb":512,"work_mem":"8MB"}}`)
			if w.Code != 500 {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
			if !reflect.DeepEqual(before, *h.tracker.GetDatabase("tenant", "app")) {
				t.Error("failed transaction updated tracked state")
			}
			if strings.Contains(w.Body.String()+logs.String(), password) {
				t.Error("password leaked through database error")
			}
		})
	}
}

func TestPasswordPatchRejectsPasswordVerifiers(t *testing.T) {
	for _, password := range []string{"md5" + strings.Repeat("a", 32), "md5" + strings.Repeat("x", 32), "SCRAM-SHA-256$stored-verifier"} {
		t.Run(strings.SplitN(password, "$", 2)[0], func(t *testing.T) {
			h, _, policy, logs := patchFixture(t)
			before := *h.tracker.GetDatabase("tenant", "app")
			body, _ := json.Marshal(map[string]any{"owner": map[string]string{"password": password}, "limits": map[string]int{"connection_limit": 20}})
			response := patchRequest(h, policy, string(body))
			if response.Code != 400 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			if !reflect.DeepEqual(before, *h.tracker.GetDatabase("tenant", "app")) {
				t.Error("rejected verifier modified state")
			}
			if strings.Contains(response.Body.String()+logs.String(), password) {
				t.Error("rejected verifier leaked")
			}
			if err := h.pg.UpdateDatabase("app", "app_owner", &password, 20, nil); err == nil {
				t.Error("PgManager accepted a password verifier")
			}
		})
	}
}
