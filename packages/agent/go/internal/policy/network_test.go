package policy

import (
	"strings"
	"testing"
)

func TestParseUpstream_Valid(t *testing.T) {
	tests := []struct {
		target   string
		wantHost string
		wantPort int
	}{
		{"10.0.0.5:8080", "10.0.0.5", 8080},
		{"localhost:3000", "localhost", 3000},
		{"db.internal:5432", "db.internal", 5432},
		{"[fd00::1]:8080", "fd00::1", 8080},
		{"10.0.0.5:1", "10.0.0.5", 1},
		{"10.0.0.5:65535", "10.0.0.5", 65535},
	}

	for _, tt := range tests {
		host, port, err := ParseUpstream(tt.target)
		if err != nil {
			t.Errorf("ParseUpstream(%q): unexpected error: %v", tt.target, err)
			continue
		}
		if host != tt.wantHost || port != tt.wantPort {
			t.Errorf("ParseUpstream(%q) = (%q, %d), want (%q, %d)", tt.target, host, port, tt.wantHost, tt.wantPort)
		}
	}
}

func TestParseUpstream_Malformed(t *testing.T) {
	// Every one of these is a target the ingress drivers would write into the
	// proxy config verbatim, so it must be an error rather than a non-match.
	tests := []string{
		"h2c://10.0.0.5:8080", // scheme prefix — SplitHostPort sees too many colons
		"http://10.0.0.5:8080",
		"10.0.0.5:8080/", // trailing path — port half is not numeric
		"10.0.0.5:8080/admin",
		"10.0.0.5",  // no port
		"10.0.0.5:", // empty port
		":8080",     // empty host
		"",
		"10.0.0.5:http",  // named port
		"10.0.0.5:0",     // port 0
		"10.0.0.5:70000", // out of range
		"10.0.0.5:-1",
		"10.0.0.5:+80",
		"fd00::1:8080", // unbracketed IPv6
	}

	for _, target := range tests {
		if _, _, err := ParseUpstream(target); err == nil {
			t.Errorf("ParseUpstream(%q): expected an error, got none", target)
		}
	}
}

func TestMatchUpstream_Patterns(t *testing.T) {
	tests := []struct {
		name     string
		target   string
		patterns []string
		want     bool
	}{
		// Exact host:port
		{"exact match", "10.0.0.2:3000", []string{"10.0.0.2:3000"}, true},
		{"exact wrong port", "10.0.0.2:3001", []string{"10.0.0.2:3000"}, false},
		{"exact wrong host", "10.0.0.3:3000", []string{"10.0.0.2:3000"}, false},
		{"hostname exact", "db.internal:5432", []string{"db.internal:5432"}, true},
		{"empty pattern list", "10.0.0.2:3000", nil, false},
		{"second pattern matches", "10.0.0.2:3000", []string{"10.0.0.9:80", "10.0.0.2:3000"}, true},

		// Port ranges
		{"range low bound", "10.0.0.2:3000", []string{"10.0.0.2:3000-3099"}, true},
		{"range high bound", "10.0.0.2:3099", []string{"10.0.0.2:3000-3099"}, true},
		{"range inside", "10.0.0.2:3050", []string{"10.0.0.2:3000-3099"}, true},
		{"range below", "10.0.0.2:2999", []string{"10.0.0.2:3000-3099"}, false},
		{"range above", "10.0.0.2:3100", []string{"10.0.0.2:3000-3099"}, false},

		// Wildcards
		{"port wildcard", "10.0.0.2:65535", []string{"10.0.0.2:*"}, true},
		{"port wildcard wrong host", "10.0.0.3:80", []string{"10.0.0.2:*"}, false},
		{"host wildcard", "192.168.1.7:8080", []string{"*:8080"}, true},
		{"host wildcard wrong port", "192.168.1.7:8081", []string{"*:8080"}, false},
		{"match everything", "10.0.0.2:3000", []string{"*:*"}, true},

		// IPv4 CIDR
		{"cidr inside", "10.0.0.7:8080", []string{"10.0.0.0/24:*"}, true},
		{"cidr outside", "10.0.1.7:8080", []string{"10.0.0.0/24:*"}, false},
		{"cidr with port range", "10.0.0.7:3050", []string{"10.0.0.0/24:3000-3099"}, true},
		{"cidr with port range outside", "10.0.0.7:4000", []string{"10.0.0.0/24:3000-3099"}, false},
		{"cidr does not match hostname", "db.internal:8080", []string{"10.0.0.0/24:*"}, false},

		// IPv6 — bracketed target, bracketed pattern
		{"ipv6 exact", "[fd00::1]:8080", []string{"[fd00::1]:8080"}, true},
		{"ipv6 wildcard port", "[fd00::1]:9999", []string{"[fd00::1]:*"}, true},
		{"ipv6 alternate spelling", "[fd00:0:0:0:0:0:0:1]:8080", []string{"[fd00::1]:8080"}, true},
		{"ipv6 cidr bracketed", "[fd00::1]:8080", []string{"[fd00::/8]:*"}, true},
		{"ipv6 cidr bracketed outside", "[fe80::1]:8080", []string{"[fd00::/8]:*"}, false},
		{"ipv4 target vs ipv6 cidr", "10.0.0.5:8080", []string{"[fd00::/8]:*"}, false},

		// Portless patterns — the natural spelling. Matches the host on any port.
		{"portless host", "10.0.0.5:8080", []string{"10.0.0.5"}, true},
		{"portless host other port", "10.0.0.5:1", []string{"10.0.0.5"}, true},
		{"portless host wrong host", "10.0.0.6:8080", []string{"10.0.0.5"}, false},
		{"portless hostname", "db.internal:5432", []string{"db.internal"}, true},
		{"portless ipv4 cidr", "10.0.0.5:8080", []string{"10.0.0.0/8"}, true},
		{"portless ipv4 cidr outside", "11.0.0.5:8080", []string{"10.0.0.0/8"}, false},
		{"portless ipv6 unbracketed", "[fd00::1]:8080", []string{"fd00::1"}, true},
		{"portless ipv6 cidr unbracketed", "[fd00::1]:8080", []string{"fd00::/8"}, true},
		{"portless ipv6 cidr bracketed", "[fd00::1]:8080", []string{"[fd00::/8]"}, true},
		{"portless ipv6 cidr outside", "[fe80::1]:8080", []string{"fd00::/8"}, false},
		{"portless star", "10.0.0.5:8080", []string{"*"}, true},

		// Patterns that cannot match. ValidateUpstreamPattern rejects these at
		// config load; the matcher must not accidentally accept one either.
		{"malformed cidr pattern", "10.0.0.5:8080", []string{"10.0.0.0/99:*"}, false},
		{"non-numeric port pattern", "10.0.0.5:8080", []string{"10.0.0.5:http"}, false},
		{"empty host pattern", "10.0.0.5:8080", []string{":8080"}, false},
	}

	for _, tt := range tests {
		got, err := MatchUpstream(tt.target, tt.patterns)
		if err != nil {
			t.Errorf("%s: MatchUpstream(%q, %v): unexpected error: %v", tt.name, tt.target, tt.patterns, err)
			continue
		}
		if got != tt.want {
			t.Errorf("%s: MatchUpstream(%q, %v) = %v, want %v", tt.name, tt.target, tt.patterns, got, tt.want)
		}
	}
}

// TestMatchUpstream_MalformedTargetErrors is the core regression for the
// fail-open deny list: a target that cannot be parsed must surface as an error,
// never as a plain false that the deny call site would read as "not denied".
func TestMatchUpstream_MalformedTargetErrors(t *testing.T) {
	malformed := []string{
		"h2c://10.0.0.5:8080",
		"http://10.0.0.5:8080",
		"10.0.0.5:8080/",
		"10.0.0.5",
		"",
	}

	// Asserted against both call-site shapes: a deny list that would otherwise
	// wave the target through, and an allow list it would otherwise fail.
	lists := map[string][]string{
		"deny list":  {"10.0.0.5:*"},
		"allow list": {"10.0.0.0/8:*"},
		"empty list": nil,
	}

	for _, target := range malformed {
		for listName, patterns := range lists {
			matched, err := MatchUpstream(target, patterns)
			if err == nil {
				t.Errorf("MatchUpstream(%q, %s): expected an error, got matched=%v", target, listName, matched)
			}
			if matched {
				t.Errorf("MatchUpstream(%q, %s): a parse failure must not report a match", target, listName)
			}
		}
	}
}

func TestMatchUpstreamHostPort(t *testing.T) {
	// The parsed-input form the ingress handler uses, so one parse serves both
	// the allow and the deny check.
	host, port, err := ParseUpstream("10.0.0.5:8080")
	if err != nil {
		t.Fatalf("ParseUpstream: %v", err)
	}

	if !MatchUpstreamHostPort(host, port, []string{"10.0.0.0/8"}) {
		t.Error("expected 10.0.0.5:8080 to match portless CIDR 10.0.0.0/8")
	}
	if MatchUpstreamHostPort(host, port, []string{"192.168.0.0/16:*"}) {
		t.Error("expected 10.0.0.5:8080 not to match 192.168.0.0/16:*")
	}
	if MatchUpstreamHostPort(host, port, nil) {
		t.Error("expected no match against an empty pattern list")
	}
}

func TestValidateUpstreamPattern_Accepted(t *testing.T) {
	valid := []string{
		"10.0.0.2:3000",
		"10.0.0.2:3000-3099",
		"10.0.0.0/24:*",
		"10.0.0.2:*",
		"*:8080",
		"*:*",
		"*",
		"db.internal:5432",
		"[fd00::1]:8080",
		"[fd00::/8]:*",
		// Portless spellings are supported, not silent no-ops.
		"10.0.0.5",
		"10.0.0.0/8",
		"fd00::1",
		"fd00::/8",
		"[fd00::/8]",
		"db.internal",
	}

	for _, pattern := range valid {
		if err := ValidateUpstreamPattern(pattern); err != nil {
			t.Errorf("ValidateUpstreamPattern(%q): unexpected error: %v", pattern, err)
		}
	}
}

func TestValidateUpstreamPattern_Rejected(t *testing.T) {
	// Each of these matches nothing at any port. Rejecting them at config load
	// is the difference between "the operator is told" and "the control silently
	// does not exist".
	invalid := []string{
		"",
		"   ",
		":8080",              // no host
		"10.0.0.0/99:*",      // malformed IPv4 CIDR
		"10.0.0.0/24:http",   // non-numeric port
		"10.0.0.2:0",         // port 0
		"10.0.0.2:70000",     // port out of range
		"10.0.0.2:3099-3000", // inverted range
		"10.0.0.2:3000-",     // incomplete range
		"10.0.0.2:-3000",
		"fd00::/8:*", // unbracketed IPv6 CIDR with a port half
	}

	for _, pattern := range invalid {
		err := ValidateUpstreamPattern(pattern)
		if err == nil {
			t.Errorf("ValidateUpstreamPattern(%q): expected an error, got none", pattern)
			continue
		}
		if pattern != "" && !strings.Contains(err.Error(), "upstream pattern") {
			t.Errorf("ValidateUpstreamPattern(%q): error should name the offending pattern, got %v", pattern, err)
		}
	}
}
