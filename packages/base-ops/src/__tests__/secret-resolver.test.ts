import { describe, it, expect } from 'vitest'
import type { InfrastructureConfig } from '../config.js'
import { InfrastructureFactsPool } from '../facts-pool.js'
import { simpleSecret, secretGroup } from '../fact.js'
import { camelCaseSplits, resolveSecret, requireSecret } from '../secret-resolver.js'

describe('camelCaseSplits', () => {
  it('splits a two-word camelCase name', () => {
    expect(camelCaseSplits('apiKey')).toEqual([{ prefix: 'api', property: 'key' }])
  })

  it('splits a three-word camelCase name into two pairs', () => {
    expect(camelCaseSplits('netbirdApiKey')).toEqual([
      { prefix: 'netbird', property: 'apiKey' },
      { prefix: 'netbirdApi', property: 'key' },
    ])
  })

  it('returns empty array for all-lowercase name', () => {
    expect(camelCaseSplits('apikey')).toEqual([])
  })

  it('returns empty array for single character', () => {
    expect(camelCaseSplits('a')).toEqual([])
  })

  it('handles leading uppercase (acronym-style)', () => {
    const splits = camelCaseSplits('awsSecretKey')
    expect(splits).toEqual([
      { prefix: 'aws', property: 'secretKey' },
      { prefix: 'awsSecret', property: 'key' },
    ])
  })

  it('handles consecutive uppercase letters', () => {
    const splits = camelCaseSplits('myAWSKey')
    expect(splits).toEqual([
      { prefix: 'my', property: 'aWSKey' },
      { prefix: 'myA', property: 'wSKey' },
      { prefix: 'myAW', property: 'sKey' },
      { prefix: 'myAWS', property: 'key' },
    ])
  })
})

describe('resolveSecret', () => {
  function poolFrom(...facts: InfrastructureConfig['facts']): InfrastructureFactsPool {
    return new InfrastructureFactsPool({ facts })
  }

  it('resolves a simple secret by exact name', () => {
    const pool = poolFrom(simpleSecret('netbirdApiKey', 's3cret', 'admin'))
    expect(resolveSecret(pool, 'netbirdApiKey')).toBe('s3cret')
  })

  it('resolves a grouped secret property via camelCase split', () => {
    const pool = poolFrom(secretGroup('netbird', { apiKey: 'key1', webhookSecret: 'wh1' }, 'admin'))
    expect(resolveSecret(pool, 'netbirdApiKey')).toBe('key1')
    expect(resolveSecret(pool, 'netbirdWebhookSecret')).toBe('wh1')
  })

  it('prefers exact match over group match', () => {
    const pool = poolFrom(
      simpleSecret('netbirdApiKey', 'exact-value', 'admin'),
      secretGroup('netbird', { apiKey: 'group-value' }, 'admin2'),
    )
    expect(resolveSecret(pool, 'netbirdApiKey')).toBe('exact-value')
  })

  it('returns undefined when secret not found', () => {
    const pool = poolFrom(simpleSecret('other', 'val', 'admin'))
    expect(resolveSecret(pool, 'netbirdApiKey')).toBeUndefined()
  })

  it('returns undefined when group exists but property does not', () => {
    const pool = poolFrom(secretGroup('netbird', { token: 'tok' }, 'admin'))
    expect(resolveSecret(pool, 'netbirdApiKey')).toBeUndefined()
  })

  it('tries multiple split points and matches the first valid one', () => {
    const pool = poolFrom(secretGroup('netbirdApi', { key: 'from-second-split' }, 'admin'))
    expect(resolveSecret(pool, 'netbirdApiKey')).toBe('from-second-split')
  })
})

describe('requireSecret', () => {
  function poolFrom(...facts: InfrastructureConfig['facts']): InfrastructureFactsPool {
    return new InfrastructureFactsPool({ facts })
  }

  it('returns value when secret exists', () => {
    const pool = poolFrom(simpleSecret('dbPassword', 'hunter2', 'admin'))
    expect(requireSecret(pool, 'dbPassword')).toBe('hunter2')
  })

  it('throws when secret not found', () => {
    const pool = poolFrom()
    expect(() => requireSecret(pool, 'missing')).toThrow('Secret "missing" not found')
  })
})
