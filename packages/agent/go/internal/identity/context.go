package identity

import (
	"context"

	"github.com/opsen/agent/internal/config"
)

type contextKey string

const clientPolicyKey contextKey = "clientPolicy"

// WithClient stores a client policy in the context.
func WithClient(ctx context.Context, policy *config.ClientPolicy) context.Context {
	return context.WithValue(ctx, clientPolicyKey, policy)
}

// ClientFromContext extracts the client policy from the request context.
func ClientFromContext(ctx context.Context) *config.ClientPolicy {
	policy, _ := ctx.Value(clientPolicyKey).(*config.ClientPolicy)
	return policy
}
