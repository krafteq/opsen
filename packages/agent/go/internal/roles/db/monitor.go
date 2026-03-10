package db

import (
	"log/slog"
	"time"

	"github.com/opsen/agent/internal/config"
)

// SizeMonitor periodically checks database sizes and enforces quotas.
type SizeMonitor struct {
	pg          *PgManager
	tracker     *ResourceTracker
	clientStore *config.ClientStore
	cfg         *config.DbRoleConfig
	logger      *slog.Logger
}

func NewSizeMonitor(
	pg *PgManager,
	tracker *ResourceTracker,
	clientStore *config.ClientStore,
	cfg *config.DbRoleConfig,
	logger *slog.Logger,
) *SizeMonitor {
	return &SizeMonitor{pg: pg, tracker: tracker, clientStore: clientStore, cfg: cfg, logger: logger}
}

// Run starts the monitoring loop. Should be called in a goroutine.
func (m *SizeMonitor) Run() {
	interval := time.Duration(m.cfg.SizeCheckInterval) * time.Second
	if interval <= 0 {
		interval = 60 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Run once immediately
	m.check()

	for range ticker.C {
		m.check()
	}
}

func (m *SizeMonitor) check() {
	allDatabases := m.tracker.AllDatabases()

	for clientName, databases := range allDatabases {
		clientPolicy := m.clientStore.Get(clientName)
		totalSizeMb := 0

		for dbName, record := range databases {
			sizeMb, err := m.pg.DatabaseSizeMb(record.DatabaseName)
			if err != nil {
				m.logger.Warn("failed to check database size",
					"client", clientName, "database", record.DatabaseName, "error", err)
				continue
			}

			totalSizeMb += sizeMb

			// Check per-database size limit
			if record.MaxSizeMb > 0 && sizeMb > record.MaxSizeMb {
				if !record.QuotaExceeded {
					m.logger.Warn("database quota exceeded, revoking connect",
						"client", clientName,
						"database", record.DatabaseName,
						"size_mb", sizeMb,
						"max_size_mb", record.MaxSizeMb)

					if err := m.pg.RevokeConnectFromOwner(record.DatabaseName, record.OwnerRole); err != nil {
						m.logger.Error("failed to revoke connect on quota exceed",
							"database", record.DatabaseName, "error", err)
					}

					m.tracker.SetQuotaExceeded(clientName, dbName, true)
				}
			} else if record.QuotaExceeded {
				// Database is back under quota
				m.logger.Info("database back under quota, restoring connect",
					"client", clientName,
					"database", record.DatabaseName,
					"size_mb", sizeMb,
					"max_size_mb", record.MaxSizeMb)

				if err := m.pg.RestoreConnectToOwner(record.DatabaseName, record.OwnerRole); err != nil {
					m.logger.Error("failed to restore connect after quota recovery",
						"database", record.DatabaseName, "error", err)
				}

				m.tracker.SetQuotaExceeded(clientName, dbName, false)
			}
		}

		// Check total size across all databases for this client
		if clientPolicy != nil && clientPolicy.Db != nil && clientPolicy.Db.MaxTotalSizeMb > 0 {
			if totalSizeMb > clientPolicy.Db.MaxTotalSizeMb {
				m.logger.Warn("client total database size exceeds limit",
					"client", clientName,
					"total_size_mb", totalSizeMb,
					"max_total_size_mb", clientPolicy.Db.MaxTotalSizeMb)
			}
		}
	}
}
