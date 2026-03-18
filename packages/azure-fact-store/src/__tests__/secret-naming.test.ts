import { describe, it, expect } from 'vitest'
import { encodeSecretName, decodeSecretName, manifestSecretName } from '../secret-naming.js'

describe('encodeSecretName / decodeSecretName', () => {
  it('round-trips a simple fact key', () => {
    const encoded = encodeSecretName('opsen', 'cluster', 'prod')
    const decoded = decodeSecretName('opsen', encoded)
    expect(decoded).toEqual({ kind: 'cluster', name: 'prod' })
  })

  it('produces a valid Key Vault name (alphanumeric + dash)', () => {
    const encoded = encodeSecretName('opsen', 'cluster', 'prod')
    expect(encoded).toMatch(/^[a-zA-Z0-9-]+$/)
  })

  it('handles special characters in kind and name', () => {
    const encoded = encodeSecretName('opsen', 'my/kind', 'some#name')
    const decoded = decodeSecretName('opsen', encoded)
    expect(decoded).toEqual({ kind: 'my/kind', name: 'some#name' })
  })

  it('returns null for non-matching prefix', () => {
    const encoded = encodeSecretName('opsen', 'cluster', 'prod')
    expect(decodeSecretName('other', encoded)).toBeNull()
  })

  it('returns null for malformed encoded value', () => {
    expect(decodeSecretName('opsen', 'opsen-notbase64valid!!!')).toBeNull()
  })

  it('uses custom prefix', () => {
    const encoded = encodeSecretName('myapp', 'cluster', 'prod')
    expect(encoded.startsWith('myapp-')).toBe(true)
    expect(decodeSecretName('myapp', encoded)).toEqual({ kind: 'cluster', name: 'prod' })
  })

  it('throws when encoded name exceeds 127 chars', () => {
    const longName = 'a'.repeat(200)
    expect(() => encodeSecretName('opsen', 'kind', longName)).toThrow('exceeds 127 chars')
  })
})

describe('manifestSecretName', () => {
  it('produces a deterministic name for an owner', () => {
    const name1 = manifestSecretName('opsen', 'org/project/stack')
    const name2 = manifestSecretName('opsen', 'org/project/stack')
    expect(name1).toBe(name2)
  })

  it('produces different names for different owners', () => {
    const name1 = manifestSecretName('opsen', 'owner-a')
    const name2 = manifestSecretName('opsen', 'owner-b')
    expect(name1).not.toBe(name2)
  })

  it('produces valid Key Vault names', () => {
    const name = manifestSecretName('opsen', 'org/project/stack')
    expect(name).toMatch(/^[a-zA-Z0-9-]+$/)
  })
})
