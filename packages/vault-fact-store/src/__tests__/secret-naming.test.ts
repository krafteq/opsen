import { describe, it, expect } from 'vitest'
import { factPath, joinPath, validatePathSegment } from '../secret-naming.js'

describe('joinPath', () => {
  it('joins non-empty segments', () => {
    expect(joinPath('a', 'b', 'c')).toBe('a/b/c')
  })

  it('skips undefined segments', () => {
    expect(joinPath(undefined, 'owner', 'kind')).toBe('owner/kind')
  })

  it('skips empty string segments', () => {
    expect(joinPath('', 'owner', 'kind')).toBe('owner/kind')
  })

  it('returns single segment', () => {
    expect(joinPath('owner')).toBe('owner')
  })

  it('returns empty string when all segments are empty', () => {
    expect(joinPath(undefined, undefined)).toBe('')
  })
})

describe('factPath', () => {
  it('builds path at mount root without basePath', () => {
    expect(factPath(undefined, 'my-stack', 'cluster', 'prod')).toBe('my-stack/cluster/prod')
  })

  it('builds path with basePath', () => {
    expect(factPath('infra', 'my-stack', 'cluster', 'prod')).toBe('infra/my-stack/cluster/prod')
  })
})

describe('validatePathSegment', () => {
  it('accepts valid names', () => {
    expect(() => validatePathSegment('Name', 'my-stack')).not.toThrow()
    expect(() => validatePathSegment('Name', 'prod')).not.toThrow()
    expect(() => validatePathSegment('Name', 'team.project')).not.toThrow()
    expect(() => validatePathSegment('Name', 'stack_v2')).not.toThrow()
    expect(() => validatePathSegment('Name', 'manual')).not.toThrow()
  })

  it('rejects slashes', () => {
    expect(() => validatePathSegment('Name', 'a/b')).toThrow('not a valid Vault path segment')
  })

  it('rejects hashes', () => {
    expect(() => validatePathSegment('Name', 'a#b')).toThrow('not a valid Vault path segment')
  })

  it('rejects spaces', () => {
    expect(() => validatePathSegment('Name', 'my name')).toThrow('not a valid Vault path segment')
  })

  it('rejects names starting with non-alphanumeric', () => {
    expect(() => validatePathSegment('Name', '-invalid')).toThrow('not a valid Vault path segment')
    expect(() => validatePathSegment('Name', '.invalid')).toThrow('not a valid Vault path segment')
    expect(() => validatePathSegment('Name', '_invalid')).toThrow('not a valid Vault path segment')
  })

  it('rejects empty string', () => {
    expect(() => validatePathSegment('Name', '')).toThrow('not a valid Vault path segment')
  })

  it('includes label in error message', () => {
    expect(() => validatePathSegment('Kind', 'a/b')).toThrow('Kind "a/b"')
    expect(() => validatePathSegment('Owner', 'x y')).toThrow('Owner "x y"')
  })
})
