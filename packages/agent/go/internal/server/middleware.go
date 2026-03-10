package server

import (
	"log/slog"
	"net/http"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

// withClient extracts the client CN from the mTLS cert and loads the policy.
func withClient(store *config.ClientStore, logger *slog.Logger, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, `{"error":"no client certificate"}`, http.StatusUnauthorized)
			return
		}

		clientName := r.TLS.PeerCertificates[0].Subject.CommonName
		if clientName == "" {
			http.Error(w, `{"error":"client certificate has no CN"}`, http.StatusUnauthorized)
			return
		}

		policy := store.Get(clientName)
		if policy == nil {
			logger.Warn("unknown client", "cn", clientName, "remote", r.RemoteAddr)
			http.Error(w, `{"error":"unknown client"}`, http.StatusForbidden)
			return
		}

		logger.Info("request", "client", clientName, "method", r.Method, "path", r.URL.Path)
		ctx := identity.WithClient(r.Context(), policy)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}
