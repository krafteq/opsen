package ingress

// Driver is the interface for ingress config backends.
type Driver interface {
	WriteConfig(clientName string, routes []Route) error
	DeleteRoute(clientName string, routeName string) error
	ListRoutes(clientName string) ([]string, error)
	Reload() error
}
