const VALID_FACT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Validate that a fact kind or name uses only portable characters.
 * Allows alphanumeric characters, dots, hyphens, and underscores.
 */
export function validateFactKey(label: string, value: string): void {
  if (!VALID_FACT_KEY.test(value)) {
    throw new Error(
      `${label} "${value}" contains invalid characters. Use only alphanumeric characters, dots, hyphens, and underscores.`,
    )
  }
}

/**
 * Encode a fact key (kind#name) as a Key Vault-safe secret name.
 * Azure Key Vault secret names allow only [a-zA-Z0-9-] and max 127 chars.
 */
export function encodeSecretName(prefix: string, kind: string, name: string): string {
  const key = `${kind}#${name}`
  const encoded = `${prefix}-${base64urlEncode(key)}`
  if (encoded.length > 127) {
    throw new Error(`Encoded secret name exceeds 127 chars: ${encoded}`)
  }
  return encoded
}

/**
 * Decode a secret name back to { kind, name }.
 * Returns null if the name doesn't match the expected prefix format.
 */
export function decodeSecretName(prefix: string, secretName: string): { kind: string; name: string } | null {
  const expectedPrefix = `${prefix}-`
  if (!secretName.startsWith(expectedPrefix)) return null

  const encoded = secretName.slice(expectedPrefix.length)
  const decoded = base64urlDecode(encoded)
  const hashIndex = decoded.indexOf('#')
  if (hashIndex === -1) return null

  return {
    kind: decoded.slice(0, hashIndex),
    name: decoded.slice(hashIndex + 1),
  }
}

/**
 * Build the manifest secret name for an owner.
 */
export function manifestSecretName(prefix: string, owner: string): string {
  return `${prefix}-manifest-${ownerHash(owner)}`
}

function base64urlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function base64urlDecode(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf-8')
}

function ownerHash(owner: string): string {
  let hash = 0
  for (let i = 0; i < owner.length; i++) {
    const char = owner.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return (hash >>> 0).toString(36)
}
