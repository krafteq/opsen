package db

import (
	"fmt"
	"strings"

	"github.com/opsen/agent/internal/config"
)

// validateCreateRequest validates the full create database request against policy.
func validateCreateRequest(name string, req *CreateDatabaseRequest, policy *config.DbPolicy, tracker *ResourceTracker, clientName string) []string {
	var violations []string

	// Check database count limit
	if policy.MaxDatabases > 0 {
		current := tracker.DatabaseCount(clientName)
		if current >= policy.MaxDatabases {
			violations = append(violations, fmt.Sprintf("database limit reached: %d (max %d)", current, policy.MaxDatabases))
		}
	}

	// Validate database name
	violations = append(violations, validateDatabaseName(name, policy)...)

	// Validate owner username
	violations = append(violations, validateUsername(req.Owner.Username, policy)...)

	// Validate owner password
	violations = append(violations, validatePassword(req.Owner.Password, req.Owner.Username, policy)...)

	// Validate limits
	if req.Limits != nil {
		violations = append(violations, validateLimits(req.Limits, policy)...)
	}

	// Validate extensions
	violations = append(violations, validateExtensions(req.Extensions, policy)...)

	// Check total size budget (estimate: new database starts at ~8MB)
	if policy.MaxTotalSizeMb > 0 {
		clientRecord := tracker.GetClient(clientName)
		if clientRecord != nil {
			totalMaxSize := 0
			for _, db := range clientRecord.Databases {
				totalMaxSize += db.MaxSizeMb
			}
			newMaxSize := 0
			if req.Limits != nil {
				newMaxSize = req.Limits.MaxSizeMb
			}
			if newMaxSize > 0 && totalMaxSize+newMaxSize > policy.MaxTotalSizeMb {
				violations = append(violations, fmt.Sprintf(
					"total max size would be %dMB (limit: %dMB)",
					totalMaxSize+newMaxSize, policy.MaxTotalSizeMb))
			}
		}
	}

	return violations
}

// validateDatabaseName checks the database name is a valid PostgreSQL identifier.
func validateDatabaseName(name string, policy *config.DbPolicy) []string {
	var violations []string

	if name == "" {
		violations = append(violations, "database name is required")
		return violations
	}

	if !isValidIdentifier(name) {
		violations = append(violations, "database name must be 1-63 characters, lowercase letters/digits/underscores, starting with a letter")
	}

	return violations
}

// validateUsername checks a username is a valid PostgreSQL identifier and respects policy restrictions.
func validateUsername(username string, policy *config.DbPolicy) []string {
	var violations []string

	if username == "" {
		violations = append(violations, "username is required")
		return violations
	}

	if !isValidIdentifier(username) {
		violations = append(violations, "username must be 1-63 characters, lowercase letters/digits/underscores, starting with a letter")
		return violations
	}

	up := policy.Username

	// Check denied names
	lower := strings.ToLower(username)
	for _, denied := range up.DeniedNames {
		if lower == strings.ToLower(denied) {
			violations = append(violations, fmt.Sprintf("username '%s' is not allowed", username))
		}
	}

	// Check denied prefixes
	for _, prefix := range up.DeniedPrefixes {
		if strings.HasPrefix(lower, strings.ToLower(prefix)) {
			violations = append(violations, fmt.Sprintf("username prefix '%s' is not allowed", prefix))
		}
	}

	return violations
}

// validateLimits checks resource limits against policy bounds.
func validateLimits(limits *DatabaseLimitsSpec, policy *config.DbPolicy) []string {
	var violations []string

	if limits.MaxSizeMb > 0 && policy.PerDatabase.MaxSizeMb > 0 {
		if limits.MaxSizeMb > policy.PerDatabase.MaxSizeMb {
			violations = append(violations, fmt.Sprintf(
				"max_size_mb %d exceeds policy limit %d", limits.MaxSizeMb, policy.PerDatabase.MaxSizeMb))
		}
	}

	if limits.ConnectionLimit > 0 && policy.PerDatabase.MaxConnectionLimit > 0 {
		if limits.ConnectionLimit > policy.PerDatabase.MaxConnectionLimit {
			violations = append(violations, fmt.Sprintf(
				"connection_limit %d exceeds policy limit %d", limits.ConnectionLimit, policy.PerDatabase.MaxConnectionLimit))
		}
	}

	if limits.WorkMem != "" && policy.RoleLimits.MaxWorkMem != "" {
		reqMb := parseMemSizeMb(limits.WorkMem)
		maxMb := parseMemSizeMb(policy.RoleLimits.MaxWorkMem)
		if reqMb > 0 && maxMb > 0 && reqMb > maxMb {
			violations = append(violations, fmt.Sprintf(
				"work_mem %s exceeds policy limit %s", limits.WorkMem, policy.RoleLimits.MaxWorkMem))
		}
	}

	if limits.TempFileLimit != "" && policy.RoleLimits.MaxTempFileLimit != "" {
		reqMb := parseMemSizeMb(limits.TempFileLimit)
		maxMb := parseMemSizeMb(policy.RoleLimits.MaxTempFileLimit)
		if reqMb > 0 && maxMb > 0 && reqMb > maxMb {
			violations = append(violations, fmt.Sprintf(
				"temp_file_limit %s exceeds policy limit %s", limits.TempFileLimit, policy.RoleLimits.MaxTempFileLimit))
		}
	}

	return violations
}

// validateExtensions checks extensions against the allowed list.
func validateExtensions(extensions []string, policy *config.DbPolicy) []string {
	var violations []string

	if len(policy.Extensions.Allowed) == 0 {
		// No allowlist means all extensions denied
		if len(extensions) > 0 {
			violations = append(violations, "extensions are not allowed by policy")
		}
		return violations
	}

	allowed := make(map[string]bool)
	for _, ext := range policy.Extensions.Allowed {
		allowed[strings.ToLower(ext)] = true
	}

	for _, ext := range extensions {
		if !allowed[strings.ToLower(ext)] {
			violations = append(violations, fmt.Sprintf("extension '%s' is not allowed", ext))
		}
	}

	return violations
}

// parseMemSizeMb parses a Postgres memory size string (e.g., "64MB", "1GB") into megabytes.
func parseMemSizeMb(s string) int {
	s = strings.TrimSpace(s)
	s = strings.ToUpper(s)

	var num int
	if strings.HasSuffix(s, "GB") {
		fmt.Sscanf(strings.TrimSuffix(s, "GB"), "%d", &num)
		return num * 1024
	}
	if strings.HasSuffix(s, "MB") {
		fmt.Sscanf(strings.TrimSuffix(s, "MB"), "%d", &num)
		return num
	}
	if strings.HasSuffix(s, "KB") {
		fmt.Sscanf(strings.TrimSuffix(s, "KB"), "%d", &num)
		return num / 1024
	}

	// Try plain number (assumed KB for Postgres GUCs)
	fmt.Sscanf(s, "%d", &num)
	return num / 1024
}
