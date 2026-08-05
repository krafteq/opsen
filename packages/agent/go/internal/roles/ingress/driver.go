package ingress

import "fmt"

// Driver is the interface for ingress config backends.
// Routes are scoped by (clientName, app) pair — each app manages its own config file.
type Driver interface {
	// ValidateRoutes reports whether the routes can be expressed by this driver.
	// It runs before WriteConfig so a rejected request leaves the on-disk config
	// untouched. Constraints differ per driver, so each implements its own.
	ValidateRoutes(routes []Route) error
	WriteConfig(clientName string, app string, routes []Route) error
	DeleteRoute(clientName string, app string, routeName string) error
	DeleteApp(clientName string, app string) error
	ListRoutes(clientName string, app string) ([]string, error)
	CountAllRoutes(clientName string) (int, error)
	Reload() error
}

// Accepted values for Route.BackendProtocol. The empty string means "unset"
// and behaves as BackendProtocolHTTP.
const (
	BackendProtocolHTTP = "http"
	BackendProtocolH2C  = "h2c"
)

// validateBackendProtocol rejects any backend_protocol value outside
// {"", "http", "h2c"}. Unknown values are errors rather than being coerced to
// the default — silently downgrading a gRPC route to HTTP/1.1 is worse than
// failing the request.
func validateBackendProtocol(route Route) error {
	switch route.BackendProtocol {
	case "", BackendProtocolHTTP, BackendProtocolH2C:
		return nil
	default:
		return fmt.Errorf("route %s: unknown backend_protocol %q (allowed: %q, %q)",
			route.Name, route.BackendProtocol, BackendProtocolHTTP, BackendProtocolH2C)
	}
}

// isH2C reports whether the route asked for HTTP/2 cleartext to the upstream.
func isH2C(route Route) bool {
	return route.BackendProtocol == BackendProtocolH2C
}
