package policy

import "strings"

// MatchDomain checks if a domain is allowed by the policy.
// More specific patterns take precedence. On equal specificity, deny wins.
func MatchDomain(domain string, allowed, denied []string) bool {
	allowScore := bestMatch(domain, allowed)
	denyScore := bestMatch(domain, denied)

	if allowScore == 0 && denyScore == 0 {
		return false // no match = deny by default
	}
	if allowScore > denyScore {
		return true
	}
	return false // deny wins on tie
}

// bestMatch returns the specificity score of the best matching pattern.
// Higher score = more specific. 0 = no match.
func bestMatch(domain string, patterns []string) int {
	best := 0
	for _, pattern := range patterns {
		score := matchScore(domain, pattern)
		if score > best {
			best = score
		}
	}
	return best
}

// matchScore returns how specific a pattern match is.
// 0 = no match. Higher = more specific.
func matchScore(domain, pattern string) int {
	// Exact match is most specific
	if domain == pattern {
		return 1000
	}

	domainParts := strings.Split(domain, ".")
	patternParts := strings.Split(pattern, ".")

	// Wildcard at the beginning: *.example.com
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[2:]
		if strings.HasSuffix(domain, suffix) && len(domainParts) > len(patternParts)-1 {
			return len(patternParts)
		}
	}

	// Wildcard at the end: admin.*
	if strings.HasSuffix(pattern, ".*") {
		prefix := pattern[:len(pattern)-2]
		if strings.HasPrefix(domain, prefix+".") {
			return len(patternParts)
		}
	}

	return 0
}
