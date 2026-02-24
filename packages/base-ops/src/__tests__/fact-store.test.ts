import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FactStoreReader, FactStoreWriter } from '../fact-store.js'
import type { InfrastructureConfig } from '../config.js'
import { InfrastructureFactsPool } from '../facts-pool.js'
import { InfrastructureConfigMerger } from '../config-merger.js'

describe('FactStoreReader', () => {
  it('returns facts from a mock reader', async () => {
    const reader: FactStoreReader = {
      async read() {
        return {
          facts: [{ kind: 'cluster', metadata: { name: 'prod' }, spec: { region: 'us-east-1' }, owner: 'stack/a/b' }],
        }
      },
    }

    const config = await reader.read()
    expect(config.facts).toHaveLength(1)
    expect(config.facts[0].kind).toBe('cluster')
    expect(config.facts[0].metadata.name).toBe('prod')
  })

  it('returns empty facts from an empty store', async () => {
    const reader: FactStoreReader = {
      async read() {
        return { facts: [] }
      },
    }

    const config = await reader.read()
    expect(config.facts).toHaveLength(0)
  })

  it('merges multiple sources into a single FactsPool', async () => {
    const reader1: FactStoreReader = {
      async read() {
        return {
          facts: [{ kind: 'cluster', metadata: { name: 'prod' }, spec: { region: 'us-east-1' }, owner: 'stack/a/b' }],
        }
      },
    }

    const reader2: FactStoreReader = {
      async read() {
        return {
          facts: [
            { kind: 'database', metadata: { name: 'main' }, spec: { host: 'db.example.com' }, owner: 'stack/c/d' },
          ],
        }
      },
    }

    const configs = await Promise.all([reader1.read(), reader2.read()])
    const merged = InfrastructureConfigMerger.merge(...configs)
    const pool = new InfrastructureFactsPool(merged)

    expect(pool.getFact('cluster', 'prod')).toBeDefined()
    expect(pool.getFact('database', 'main')).toBeDefined()
  })

  it('throws on duplicate facts across sources', async () => {
    const reader1: FactStoreReader = {
      async read() {
        return {
          facts: [{ kind: 'cluster', metadata: { name: 'prod' }, spec: {}, owner: 'stack/a/b' }],
        }
      },
    }

    const reader2: FactStoreReader = {
      async read() {
        return {
          facts: [{ kind: 'cluster', metadata: { name: 'prod' }, spec: {}, owner: 'stack/c/d' }],
        }
      },
    }

    const configs = await Promise.all([reader1.read(), reader2.read()])
    const merged = InfrastructureConfigMerger.merge(...configs)

    expect(() => new InfrastructureFactsPool(merged)).toThrow('Fact cluster prod already exists')
  })
})

describe('FactStoreWriter', () => {
  it('receives the correct config on write', async () => {
    const written: InfrastructureConfig[] = []

    const writer: FactStoreWriter = {
      async write(config) {
        written.push(config)
      },
    }

    const config: InfrastructureConfig = {
      facts: [{ kind: 'cluster', metadata: { name: 'prod' }, spec: { region: 'us-east-1' }, owner: 'stack/a/b' }],
    }

    await writer.write(config)

    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(config)
  })

  it('propagates write errors', async () => {
    const writer: FactStoreWriter = {
      async write() {
        throw new Error('write failed')
      },
    }

    await expect(writer.write({ facts: [] })).rejects.toThrow('write failed')
  })
})

describe('PulumiFactStore', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reads config from StackReference', async () => {
    const expectedConfig: InfrastructureConfig = {
      facts: [{ kind: 'cluster', metadata: { name: 'prod' }, spec: { region: 'us-east-1' }, owner: 'stack/a/b' }],
    }

    vi.doMock('../stack-reference.js', () => ({
      StackReference: {
        get: vi.fn().mockReturnValue({
          getOutput: vi.fn().mockReturnValue({
            apply: (fn: (val: unknown) => void) => fn(expectedConfig),
          }),
        }),
      },
    }))

    const { PulumiFactStore } = await import('../pulumi-fact-store.js')
    const store = new PulumiFactStore('org/project/stack')
    const config = await store.read()

    expect(config).toEqual(expectedConfig)
  })

  it('returns empty facts when stack output is undefined', async () => {
    vi.doMock('../stack-reference.js', () => ({
      StackReference: {
        get: vi.fn().mockReturnValue({
          getOutput: vi.fn().mockReturnValue({
            apply: (fn: (val: unknown) => void) => fn(undefined),
          }),
        }),
      },
    }))

    const { PulumiFactStore } = await import('../pulumi-fact-store.js')
    const store = new PulumiFactStore('org/project/stack')
    const config = await store.read()

    expect(config).toEqual({ facts: [] })
  })
})
