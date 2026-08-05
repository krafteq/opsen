package policy

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// ParseUpstream splits an upstream target into its host and numeric port.
//
// Anything that is not a bare host:port is an error rather than a silent
// non-match. The ingress drivers write Route.Upstream into the proxy config
// verbatim, so a scheme-prefixed target ("h2c://10.0.0.5:8080") or one carrying
// a path ("10.0.0.5:8080/") is a route that proxies normally while being
// invisible to the matcher below — callers must reject it, not guess.
func ParseUpstream(target string) (string, int, error) {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return "", 0, fmt.Errorf("%q is not a valid host:port: %w", target, err)
	}
	if host == "" {
		return "", 0, fmt.Errorf("%q has an empty host", target)
	}
	port, err := parsePort(portStr)
	if err != nil {
		return "", 0, fmt.Errorf("%q: %w", target, err)
	}
	return host, port, nil
}

// MatchUpstream reports whether a host:port target matches any policy pattern.
//
// Patterns can be "10.0.0.2:3000", "10.0.0.2:3000-3099", "10.0.0.0/24:*",
// "10.0.0.2:*", or portless — "10.0.0.5", "10.0.0.0/8", "fd00::/8" — which match
// the host on any port. IPv6 patterns may also be written bracketed:
// "[fd00::1]:8080", "[fd00::/8]:*".
//
// The error return distinguishes "does not match" from "could not be parsed".
// The two are not interchangeable: the deny-list call site reads false as "not
// denied", so folding a parse failure into false makes the deny list fail open.
func MatchUpstream(target string, patterns []string) (bool, error) {
	host, port, err := ParseUpstream(target)
	if err != nil {
		return false, err
	}
	return MatchUpstreamHostPort(host, port, patterns), nil
}

// MatchUpstreamHostPort is MatchUpstream over an already-parsed target. Callers
// that need to check a target against both the allow and the deny list parse
// once with ParseUpstream and match twice with this.
func MatchUpstreamHostPort(host string, port int, patterns []string) bool {
	for _, pattern := range patterns {
		if matchUpstreamPattern(host, port, pattern) {
			return true
		}
	}
	return false
}

// ValidateUpstreamPattern reports whether a policy pattern can ever match.
//
// A pattern that cannot — a malformed CIDR, a non-numeric or inverted port range
// — is a silent no-op at match time, indistinguishable from a control that was
// never configured. Config load rejects such a pattern so the operator hears
// about it instead of believing a deny list is active.
func ValidateUpstreamPattern(pattern string) error {
	if strings.TrimSpace(pattern) == "" {
		return fmt.Errorf("upstream pattern is empty")
	}

	host, port := splitPattern(pattern)
	if err := validatePatternHost(host); err != nil {
		return fmt.Errorf("upstream pattern %q: %w", pattern, err)
	}
	if err := validatePatternPort(port); err != nil {
		return fmt.Errorf("upstream pattern %q: %w", pattern, err)
	}
	return nil
}

func matchUpstreamPattern(host string, port int, pattern string) bool {
	patternHost, patternPort := splitPattern(pattern)

	if !matchHost(host, patternHost) {
		return false
	}
	return matchPort(port, patternPort)
}

// splitPattern splits a policy pattern into its host and port halves. A pattern
// carrying no port — "10.0.0.5", "10.0.0.0/8", "fd00::/8" — matches the host on
// any port, so the port half defaults to "*".
func splitPattern(pattern string) (host, port string) {
	if h, p, err := net.SplitHostPort(pattern); err == nil {
		return h, p
	}

	// Portless: the whole pattern is the host. Strip the brackets an IPv6
	// literal or CIDR may carry, matching what SplitHostPort would have done.
	host = pattern
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	return host, "*"
}

func matchHost(host, pattern string) bool {
	if pattern == "*" {
		return true
	}

	// CIDR match
	if strings.Contains(pattern, "/") {
		_, network, err := net.ParseCIDR(pattern)
		if err != nil {
			return false
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return false
		}
		return network.Contains(ip)
	}

	if host == pattern {
		return true
	}

	// Compare IP literals by value so equivalent spellings of one address
	// ("fd00::1" and "fd00:0:0:0:0:0:0:1") match.
	if ip, patternIP := net.ParseIP(host), net.ParseIP(pattern); ip != nil && patternIP != nil {
		return ip.Equal(patternIP)
	}

	return false
}

func matchPort(port int, pattern string) bool {
	if pattern == "*" {
		return true
	}

	// Range: 3000-3099
	if strings.Contains(pattern, "-") {
		low, high, err := parsePortRangeBounds(pattern)
		if err != nil {
			return false
		}
		return port >= low && port <= high
	}

	// Exact port
	p, err := parsePort(pattern)
	if err != nil {
		return false
	}
	return port == p
}

func validatePatternHost(host string) error {
	if host == "*" {
		return nil
	}
	if host == "" {
		return fmt.Errorf("empty host — it can never match a target")
	}
	if strings.Contains(host, "/") {
		if _, _, err := net.ParseCIDR(host); err != nil {
			return fmt.Errorf("invalid CIDR %q: %w", host, err)
		}
	}
	return nil
}

func validatePatternPort(port string) error {
	if port == "*" {
		return nil
	}
	if strings.Contains(port, "-") {
		low, high, err := parsePortRangeBounds(port)
		if err != nil {
			return err
		}
		if low > high {
			return fmt.Errorf("port range %q is inverted (%d > %d)", port, low, high)
		}
		return nil
	}
	if _, err := parsePort(port); err != nil {
		return err
	}
	return nil
}

func parsePortRangeBounds(portRange string) (int, int, error) {
	parts := strings.SplitN(portRange, "-", 2)
	low, err := parsePort(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("port range %q low bound: %w", portRange, err)
	}
	high, err := parsePort(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("port range %q high bound: %w", portRange, err)
	}
	return low, high, nil
}

// parsePort accepts only a decimal port in 1-65535. ParseUint rather than Atoi
// so signed spellings ("+80", "-1") are rejected rather than coerced.
func parsePort(port string) (int, error) {
	p, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return 0, fmt.Errorf("invalid port %q: must be a number in 1-65535", port)
	}
	if p == 0 {
		return 0, fmt.Errorf("invalid port %q: must be a number in 1-65535", port)
	}
	return int(p), nil
}

// ParsePortRange parses a range like "3000-3099" and returns low, high.
func ParsePortRange(portRange string) (int, int, error) {
	parts := strings.SplitN(portRange, "-", 2)
	if len(parts) != 2 {
		p, err := strconv.Atoi(portRange)
		if err != nil {
			return 0, 0, fmt.Errorf("invalid port range: %s", portRange)
		}
		return p, p, nil
	}

	low, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid port range low: %s", parts[0])
	}
	high, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid port range high: %s", parts[1])
	}

	return low, high, nil
}
