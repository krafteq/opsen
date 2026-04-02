import { SIMPLE_SECRET_KIND } from './fact'
import { InfrastructureFactsPool } from './facts-pool'

export interface SecretSplit {
  prefix: string
  property: string
}

/**
 * Split a camelCase name into all possible (prefix, property) pairs.
 *
 * "netbirdApiKey" → [{ prefix: "netbird", property: "apiKey" }, { prefix: "netbirdApi", property: "key" }]
 */
export function camelCaseSplits(name: string): SecretSplit[] {
  const splits: SecretSplit[] = []

  for (let i = 1; i < name.length; i++) {
    if (name[i] >= 'A' && name[i] <= 'Z') {
      const prefix = name.slice(0, i)
      const rest = name.slice(i)
      const property = rest[0].toLowerCase() + rest.slice(1)
      splits.push({ prefix, property })
    }
  }

  return splits
}

/**
 * Resolve a secret name to its string value.
 *
 * 1. Exact match — looks up `secret#<name>` and returns `.spec.value`
 * 2. Group match — splits name at camelCase boundaries and tries each
 *    `(prefix, property)` pair against the pool
 *
 * Returns `undefined` if no match is found.
 */
export function resolveSecret(pool: InfrastructureFactsPool, name: string): string | undefined {
  const direct = pool.getFact(SIMPLE_SECRET_KIND, name)
  if (direct && typeof direct.spec.value === 'string') {
    return direct.spec.value
  }

  for (const { prefix, property } of camelCaseSplits(name)) {
    const group = pool.getFact(SIMPLE_SECRET_KIND, prefix)
    if (group) {
      const value = (group.spec as Record<string, unknown>)[property]
      if (typeof value === 'string') {
        return value
      }
    }
  }

  return undefined
}

/**
 * Resolve a secret name to its string value, throwing if not found.
 */
export function requireSecret(pool: InfrastructureFactsPool, name: string): string {
  const value = resolveSecret(pool, name)
  if (value === undefined) {
    throw new Error(`Secret "${name}" not found`)
  }
  return value
}
