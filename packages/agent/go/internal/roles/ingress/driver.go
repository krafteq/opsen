package ingress

// Driver is the interface for ingress config backends.
// Routes are scoped by (clientName, app) pair — each app manages its own config file.
type Driver interface {
	WriteConfig(clientName string, app string, routes []Route) error
	DeleteRoute(clientName string, app string, routeName string) error
	DeleteApp(clientName string, app string) error
	ListRoutes(clientName string, app string) ([]string, error)
	CountAllRoutes(clientName string) (int, error)
	Reload() error
}
