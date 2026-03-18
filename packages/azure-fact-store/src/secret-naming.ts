const VALID_KEY = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

/**
 * Validate that a value uses only Key Vault-safe characters.
 * Allows alphanumeric characters and single hyphens (no consecutive `--`).
 */
export function validateFactKey(label: string, value: string): void {
  if (!VALID_KEY.test(value)) {
    throw new Error(`${label} "${value}" contains invalid characters. Use only alphanumeric characters and hyphens.`)
  }
  if (value.includes('--')) {
    throw new Error(`${label} "${value}" must not contain consecutive hyphens (--)`)
  }
}

/**
 * Build a Key Vault secret name from owner, kind, and name.
 * Format: `{owner}--{kind}--{name}` (with owner) or `{kind}--{name}` (without).
 */
export function encodeSecretName(owner: string | undefined, kind: string, name: string): string {
  const parts = owner ? [owner, kind, name] : [kind, name]
  const encoded = parts.join('--')
  if (encoded.length > 127) {
    throw new Error(`Encoded secret name exceeds 127 chars: ${encoded}`)
  }
  return encoded
}
