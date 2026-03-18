import { describe, it, expect } from 'vitest'
import { encodeSecretName, validateFactKey } from '../secret-naming.js'

describe('validateFactKey', () => {
  it('accepts alphanumeric with single hyphens', () => {
    expect(() => validateFactKey('Kind', 'cluster')).not.toThrow()
    expect(() => validateFactKey('Kind', 'my-cluster')).not.toThrow()
    expect(() => validateFactKey('Kind', 'prod-v2')).not.toThrow()
  })

  it('rejects dots', () => {
    expect(() => validateFactKey('Kind', 'prod.v2')).toThrow('invalid characters')
  })

  it('rejects underscores', () => {
    expect(() => validateFactKey('Name', 'my_name')).toThrow('invalid characters')
  })

  it('rejects slashes', () => {
    expect(() => validateFactKey('Kind', 'a/b')).toThrow('invalid characters')
  })

  it('rejects consecutive hyphens', () => {
    expect(() => validateFactKey('Kind', 'my--cluster')).toThrow('consecutive hyphens')
  })

  it('rejects leading hyphen', () => {
    expect(() => validateFactKey('Kind', '-cluster')).toThrow('invalid characters')
  })
})

describe('encodeSecretName', () => {
  it('encodes without owner', () => {
    expect(encodeSecretName(undefined, 'cluster', 'prod')).toBe('cluster--prod')
  })

  it('encodes with owner', () => {
    expect(encodeSecretName('myapp', 'cluster', 'prod')).toBe('myapp--cluster--prod')
  })

  it('produces valid Key Vault names (alphanumeric + dash)', () => {
    const encoded = encodeSecretName('myapp', 'cluster', 'prod')
    expect(encoded).toMatch(/^[a-zA-Z0-9-]+$/)
  })

  it('throws when encoded name exceeds 127 chars', () => {
    const longName = 'a'.repeat(200)
    expect(() => encodeSecretName(undefined, 'kind', longName)).toThrow('exceeds 127 chars')
  })
})
