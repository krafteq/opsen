import { InfrastructureFactsPool } from './facts-pool'

export type { SecretSplit } from './facts-pool'
export { camelCaseSplits } from './facts-pool'

/**
 * Resolve a secret name to its string value.
 *
 * @deprecated Use `pool.getSecret(name)` directly instead.
 */
export function resolveSecret(pool: InfrastructureFactsPool, name: string): string | undefined {
  return pool.getSecret(name)
}

/**
 * Resolve a secret name to its string value, throwing if not found.
 *
 * @deprecated Use `pool.requireSecret(name)` directly instead.
 */
export function requireSecret(pool: InfrastructureFactsPool, name: string): string {
  return pool.requireSecret(name)
}
