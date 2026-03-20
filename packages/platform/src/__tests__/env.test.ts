import { describe, it, expect } from 'vitest'
import { isSecretValue, isSecretRef, isPlainEnvVar, resolveEnvValue, isSecretContent, resolveFileContent } from '../env'
import type { SecretRef } from '../workload'

describe('env type guards', () => {
  describe('isPlainEnvVar', () => {
    it('returns true for plain strings', () => {
      expect(isPlainEnvVar('hello')).toBe(true)
      expect(isPlainEnvVar('')).toBe(true)
    })

    it('returns false for SecretValue', () => {
      expect(isPlainEnvVar({ type: 'secret', value: 'x' })).toBe(false)
    })

    it('returns false for SecretRef', () => {
      expect(isPlainEnvVar({ type: 'secret', valueRef: { secretName: 'a', key: 'b' } })).toBe(false)
    })
  })

  describe('isSecretValue', () => {
    it('returns true for SecretValue', () => {
      expect(isSecretValue({ type: 'secret', value: 'my-secret' })).toBe(true)
    })

    it('returns false for plain strings', () => {
      expect(isSecretValue('hello')).toBe(false)
    })

    it('returns false for SecretRef', () => {
      expect(isSecretValue({ type: 'secret', valueRef: { secretName: 'a', key: 'b' } })).toBe(false)
    })
  })

  describe('isSecretRef', () => {
    it('returns true for SecretRef', () => {
      expect(isSecretRef({ type: 'secret', valueRef: { secretName: 'tls', key: 'tls.key' } })).toBe(true)
    })

    it('returns false for plain strings', () => {
      expect(isSecretRef('hello')).toBe(false)
    })

    it('returns false for SecretValue', () => {
      expect(isSecretRef({ type: 'secret', value: 'x' })).toBe(false)
    })
  })

  describe('resolveEnvValue', () => {
    it('returns plain string as-is', () => {
      expect(resolveEnvValue('hello')).toBe('hello')
    })

    it('extracts value from SecretValue', () => {
      expect(resolveEnvValue({ type: 'secret', value: 'my-secret' })).toBe('my-secret')
    })

    it('throws for SecretRef', () => {
      const ref: SecretRef = { type: 'secret', valueRef: { secretName: 'a', key: 'b' } }
      expect(() => resolveEnvValue(ref)).toThrow('Cannot resolve env value from SecretRef')
    })
  })
})

describe('file content helpers', () => {
  describe('isSecretContent', () => {
    it('returns false for plain string content', () => {
      expect(isSecretContent('plain text')).toBe(false)
    })

    it('returns true for SecretValue content', () => {
      expect(isSecretContent({ type: 'secret', value: 'secret data' })).toBe(true)
    })

    it('returns true for SecretRef content', () => {
      expect(isSecretContent({ type: 'secret', valueRef: { secretName: 'tls', key: 'tls.key' } })).toBe(true)
    })
  })

  describe('resolveFileContent', () => {
    it('returns plain string as-is', () => {
      expect(resolveFileContent('file contents')).toBe('file contents')
    })

    it('extracts value from SecretValue', () => {
      expect(resolveFileContent({ type: 'secret', value: 'secret data' })).toBe('secret data')
    })

    it('throws for SecretRef', () => {
      expect(() => resolveFileContent({ type: 'secret', valueRef: { secretName: 'a', key: 'b' } })).toThrow(
        'Cannot resolve file content from SecretRef',
      )
    })
  })
})
