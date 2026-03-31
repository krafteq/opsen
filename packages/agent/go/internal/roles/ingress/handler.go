package ingress

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
	"github.com/opsen/agent/internal/policy"
)

type Handler struct {
	cfg         *config.AgentConfig
	clientStore *config.ClientStore
	logger      *slog.Logger
	driver      Driver
}

func NewHandler(cfg *config.AgentConfig, clientStore *config.ClientStore, logger *slog.Logger) *Handler {
	var driver Driver
	switch cfg.Roles.Ingress.Driver {
	case "caddy":
		driver = &CaddyDriver{configDir: cfg.Roles.Ingress.ConfigDir, reloadCmd: cfg.Roles.Ingress.ReloadCommand}
	default:
		driver = &TraefikDriver{configDir: cfg.Roles.Ingress.ConfigDir}
	}

	return &Handler{cfg: cfg, clientStore: clientStore, logger: logger, driver: driver}
}

type RouteRequest struct {
	Routes []Route `json:"routes"`
}

type Route struct {
	Name         string            `json:"name"`
	Hosts        []string          `json:"hosts"`
	Upstream     string            `json:"upstream"`
	PathPrefix   string            `json:"path_prefix,omitempty"`
	BindAddress  string            `json:"bind_address,omitempty"`
	TLS          *RouteTLS         `json:"tls,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	CORS         *CORSConfig       `json:"cors,omitempty"`
	RateLimitRps int               `json:"rate_limit_rps,omitempty"`
}

type RouteTLS struct {
	ACME bool `json:"acme"`
}

type CORSConfig struct {
	Origins []string `json:"origins"`
	Methods []string `json:"methods"`
}

func (h *Handler) UpdateRoutes(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	if client.Ingress == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "ingress role not allowed for this client"})
		return
	}

	var req RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Validate routes against policy
	violations := h.validateRoutes(req.Routes, client.Ingress)
	if len(violations) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":      "policy violations",
			"violations": violations,
		})
		return
	}

	// Inject platform defaults
	modifications := h.injectDefaults(req.Routes, client.Ingress)

	// Generate and write config
	if err := h.driver.WriteConfig(client.Client, req.Routes); err != nil {
		h.logger.Error("failed to write ingress config", "client", client.Client, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write config"})
		return
	}

	// Reload if needed
	if err := h.driver.Reload(); err != nil {
		h.logger.Error("failed to reload ingress", "client", client.Client, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to reload ingress"})
		return
	}

	h.logger.Info("ingress updated", "client", client.Client, "routes", len(req.Routes))
	writeJSON(w, http.StatusOK, map[string]any{
		"status":              "updated",
		"routes":              len(req.Routes),
		"policy_modifications": modifications,
	})
}

func (h *Handler) DeleteRoute(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	routeName := r.PathValue("name")

	if err := h.driver.DeleteRoute(client.Client, routeName); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to delete route: %v", err)})
		return
	}

	if err := h.driver.Reload(); err != nil {
		h.logger.Error("failed to reload after delete", "error", err)
	}

	h.logger.Info("route deleted", "client", client.Client, "route", routeName)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "route": routeName})
}

func (h *Handler) ListRoutes(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())

	routes, err := h.driver.ListRoutes(client.Client)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to list routes: %v", err)})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"routes": routes})
}

func (h *Handler) validateRoutes(routes []Route, pol *config.IngressPolicy) []string {
	var violations []string

	if pol.MaxRoutes > 0 && len(routes) > pol.MaxRoutes {
		violations = append(violations, fmt.Sprintf("too many routes: %d (max %d)", len(routes), pol.MaxRoutes))
	}

	for _, route := range routes {
		// Domain validation
		for _, host := range route.Hosts {
			if !policy.MatchDomain(host, pol.Domains.Allowed, pol.Domains.Denied) {
				violations = append(violations, fmt.Sprintf("route %s: domain '%s' not allowed", route.Name, host))
			}
		}

		// Upstream validation
		if route.Upstream != "" {
			if len(pol.Upstreams.AllowedTargets) > 0 && !policy.MatchUpstream(route.Upstream, pol.Upstreams.AllowedTargets) {
				violations = append(violations, fmt.Sprintf("route %s: upstream '%s' not in allowed targets", route.Name, route.Upstream))
			}
			if policy.MatchUpstream(route.Upstream, pol.Upstreams.DenyTargets) {
				violations = append(violations, fmt.Sprintf("route %s: upstream '%s' is denied", route.Name, route.Upstream))
			}
		}

		// Rate limit validation
		if route.RateLimitRps > 0 && pol.RateLimiting.MaxRps > 0 && route.RateLimitRps > pol.RateLimiting.MaxRps {
			violations = append(violations, fmt.Sprintf("route %s: rate limit %d exceeds max %d", route.Name, route.RateLimitRps, pol.RateLimiting.MaxRps))
		}
	}

	return violations
}

func (h *Handler) injectDefaults(routes []Route, pol *config.IngressPolicy) []string {
	var modifications []string

	for i := range routes {
		route := &routes[i]

		// Default rate limit
		if route.RateLimitRps == 0 && pol.RateLimiting.Enabled && pol.RateLimiting.DefaultRps > 0 {
			route.RateLimitRps = pol.RateLimiting.DefaultRps
			modifications = append(modifications, fmt.Sprintf("route %s: set default rate_limit %d rps", route.Name, pol.RateLimiting.DefaultRps))
		}

		// Platform security headers are injected by the driver during config generation
		if pol.Headers.ForceHSTS {
			modifications = append(modifications, fmt.Sprintf("route %s: injected HSTS header", route.Name))
		}
		if pol.Headers.ForceXSSProtection {
			modifications = append(modifications, fmt.Sprintf("route %s: injected XSS protection headers", route.Name))
		}
	}

	return modifications
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
