package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/roles/compose"
	dbRole "github.com/opsen/agent/internal/roles/db"
	"github.com/opsen/agent/internal/roles/ingress"
)

type Server struct {
	httpServer     *http.Server
	cfg            *config.AgentConfig
	clientStore    *config.ClientStore
	logger         *slog.Logger
	dbHandler      *dbRole.Handler
	composeHandler *compose.Handler
}

func New(cfg *config.AgentConfig, clientStore *config.ClientStore, logger *slog.Logger) (*Server, error) {
	mux := http.NewServeMux()

	// Health endpoint — no auth required
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Compose role (Docker Compose project deployments)
	var composeHandler *compose.Handler
	if cfg.Roles.Compose != nil {
		composeHandler = compose.NewHandler(cfg, clientStore, logger)
		mux.HandleFunc("PUT /v1/compose/projects/{project}", withClient(clientStore, logger, composeHandler.Deploy))
		mux.HandleFunc("DELETE /v1/compose/projects/{project}", withClient(clientStore, logger, composeHandler.Destroy))
		mux.HandleFunc("GET /v1/compose/projects/{project}", withClient(clientStore, logger, composeHandler.Status))
		mux.HandleFunc("GET /v1/compose/projects", withClient(clientStore, logger, composeHandler.Status))
		logger.Info("compose role enabled")
	}

	// Database role
	var dbHandler *dbRole.Handler
	if cfg.Roles.Db != nil {
		var err error
		dbHandler, err = dbRole.NewHandler(cfg, clientStore, logger)
		if err != nil {
			return nil, fmt.Errorf("initializing db handler: %w", err)
		}
		mux.HandleFunc("PUT /v1/db/databases/{name}", withClient(clientStore, logger, dbHandler.CreateDatabase))
		mux.HandleFunc("PATCH /v1/db/databases/{name}", withClient(clientStore, logger, dbHandler.UpdateDatabase))
		mux.HandleFunc("DELETE /v1/db/databases/{name}", withClient(clientStore, logger, dbHandler.DropDatabase))
		mux.HandleFunc("GET /v1/db/databases/{name}", withClient(clientStore, logger, dbHandler.DatabaseStatus))
		mux.HandleFunc("GET /v1/db/databases", withClient(clientStore, logger, dbHandler.DatabaseStatus))
		mux.HandleFunc("PUT /v1/db/databases/{name}/roles/{role}", withClient(clientStore, logger, dbHandler.CreateRole))
		mux.HandleFunc("DELETE /v1/db/databases/{name}/roles/{role}", withClient(clientStore, logger, dbHandler.DropRole))
		logger.Info("db role enabled")
	}

	// Ingress role
	if cfg.Roles.Ingress != nil {
		ih := ingress.NewHandler(cfg, clientStore, logger)

		// App-scoped endpoints
		mux.HandleFunc("PUT /v1/ingress/apps/{app}/routes", withClient(clientStore, logger, ih.UpdateAppRoutes))
		mux.HandleFunc("GET /v1/ingress/apps/{app}/routes", withClient(clientStore, logger, ih.ListAppRoutes))
		mux.HandleFunc("DELETE /v1/ingress/apps/{app}", withClient(clientStore, logger, ih.DeleteApp))

		// Legacy endpoints (backwards compat, use _default app)
		mux.HandleFunc("PUT /v1/ingress/routes", withClient(clientStore, logger, ih.UpdateRoutes))
		mux.HandleFunc("DELETE /v1/ingress/routes/{name}", withClient(clientStore, logger, ih.DeleteRoute))
		mux.HandleFunc("GET /v1/ingress/routes", withClient(clientStore, logger, ih.ListRoutes))

		logger.Info("ingress role enabled")
	}

	// Load CA for client verification
	caCert, err := os.ReadFile(cfg.TLS.CA)
	if err != nil {
		return nil, fmt.Errorf("reading CA cert: %w", err)
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("failed to parse CA cert")
	}

	minVersion := tls.VersionTLS13
	if cfg.TLS.MinVersion == "1.2" {
		minVersion = tls.VersionTLS12
	}

	tlsConfig := &tls.Config{
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  caPool,
		MinVersion: uint16(minVersion),
	}

	httpServer := &http.Server{
		Addr:         cfg.Listen,
		Handler:      mux,
		TLSConfig:    tlsConfig,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	return &Server{
		httpServer:     httpServer,
		cfg:            cfg,
		clientStore:    clientStore,
		logger:         logger,
		dbHandler:      dbHandler,
		composeHandler: composeHandler,
	}, nil
}

// DbHandler returns the db role handler, if enabled. Used to start the size monitor.
func (s *Server) DbHandler() *dbRole.Handler {
	return s.dbHandler
}

// ComposeHandler returns the compose role handler, if enabled. Used to start the reconciler.
func (s *Server) ComposeHandler() *compose.Handler {
	return s.composeHandler
}

func (s *Server) ListenAndServeTLS() error {
	return s.httpServer.ListenAndServeTLS(s.cfg.TLS.Cert, s.cfg.TLS.Key)
}

func (s *Server) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.httpServer.Shutdown(ctx)
}
