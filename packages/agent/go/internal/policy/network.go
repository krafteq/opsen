package policy

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// MatchUpstream checks if a host:port target matches a policy pattern.
// Patterns can be: "10.0.0.2:3000", "10.0.0.2:3000-3099", "10.0.0.0/24:*", "10.0.0.2:*"
func MatchUpstream(target string, patterns []string) bool {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return false
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return false
	}

	for _, pattern := range patterns {
		if matchUpstreamPattern(host, port, pattern) {
			return true
		}
	}
	return false
}

func matchUpstreamPattern(host string, port int, pattern string) bool {
	patternHost, patternPort, err := net.SplitHostPort(pattern)
	if err != nil {
		// Try without port (host-only pattern)
		return false
	}

	// Match host
	if !matchHost(host, patternHost) {
		return false
	}

	// Match port
	return matchPort(port, patternPort)
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

	return host == pattern
}

func matchPort(port int, pattern string) bool {
	if pattern == "*" {
		return true
	}

	// Range: 3000-3099
	if strings.Contains(pattern, "-") {
		parts := strings.SplitN(pattern, "-", 2)
		low, err1 := strconv.Atoi(parts[0])
		high, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil {
			return false
		}
		return port >= low && port <= high
	}

	// Exact port
	p, err := strconv.Atoi(pattern)
	if err != nil {
		return false
	}
	return port == p
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
