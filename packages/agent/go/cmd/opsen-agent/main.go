package main

import (
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/server"
)

func main() {
	configPath := flag.String("config", "/etc/opsen-agent/agent.yaml", "path to agent config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	logger := setupLogger(cfg)

	clientStore, err := config.NewClientStore(cfg.ClientsDir, logger)
	if err != nil {
		slog.Error("failed to load client policies", "error", err)
		os.Exit(1)
	}

	if cfg.Reload.WatchClientsDir {
		go clientStore.Watch()
	}

	srv, err := server.New(cfg, clientStore, logger)
	if err != nil {
		slog.Error("failed to create server", "error", err)
		os.Exit(1)
	}

	// Start db size monitor if db role is enabled
	if dbHandler := srv.DbHandler(); dbHandler != nil {
		monitor := dbHandler.Monitor()
		go monitor.Run()
		defer dbHandler.Close()
	}

	// Start compose policy reconciler if compose role is enabled
	if ch := srv.ComposeHandler(); ch != nil {
		reconciler := ch.Reconciler()
		go reconciler.Run(10 * time.Second)
	}

	go func() {
		logger.Info("starting opsen-agent", "listen", cfg.Listen)
		if err := srv.ListenAndServeTLS(); err != nil {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	logger.Info("shutting down")
	srv.Shutdown()
}

func setupLogger(cfg *config.AgentConfig) *slog.Logger {
	var level slog.Level
	switch cfg.Logging.Level {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: level}

	if cfg.Logging.File != "" {
		f, err := os.OpenFile(cfg.Logging.File, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			slog.Error("failed to open log file, falling back to stderr", "error", err)
			return slog.New(slog.NewJSONHandler(os.Stderr, opts))
		}
		return slog.New(slog.NewJSONHandler(f, opts))
	}

	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}
