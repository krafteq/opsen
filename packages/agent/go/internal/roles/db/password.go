package db

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/opsen/agent/internal/config"
)

// validatePassword checks a password against the client's password policy.
func validatePassword(password, username string, policy *config.DbPolicy) []string {
	var violations []string
	pp := policy.Password

	if pp.MinLength > 0 && len(password) < pp.MinLength {
		violations = append(violations, fmt.Sprintf("password too short: minimum %d characters", pp.MinLength))
	}

	if pp.RequireUppercase && !containsType(password, unicode.IsUpper) {
		violations = append(violations, "password must contain at least one uppercase letter")
	}

	if pp.RequireLowercase && !containsType(password, unicode.IsLower) {
		violations = append(violations, "password must contain at least one lowercase letter")
	}

	if pp.RequireDigit && !containsType(password, unicode.IsDigit) {
		violations = append(violations, "password must contain at least one digit")
	}

	if pp.RequireSpecial && !containsSpecial(password) {
		violations = append(violations, "password must contain at least one special character")
	}

	if pp.DenyUsernameInPassword && username != "" {
		if strings.Contains(strings.ToLower(password), strings.ToLower(username)) {
			violations = append(violations, "password must not contain the username")
		}
	}

	// Check against common weak passwords
	lower := strings.ToLower(password)
	weakPasswords := []string{
		"password", "123456", "qwerty", "letmein", "admin",
		"welcome", "monkey", "master", "dragon", "login",
		"abc123", "111111", "passw0rd", "trustno1",
	}
	for _, weak := range weakPasswords {
		if lower == weak {
			violations = append(violations, "password is too common")
			break
		}
	}

	return violations
}

func containsType(s string, check func(rune) bool) bool {
	for _, r := range s {
		if check(r) {
			return true
		}
	}
	return false
}

func containsSpecial(s string) bool {
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return true
		}
	}
	return false
}
