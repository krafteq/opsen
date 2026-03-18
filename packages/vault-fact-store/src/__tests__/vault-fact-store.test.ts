import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InfrastructureFact } from '@opsen/base-ops'
import { SIMPLE_SECRET_KIND, simpleSecret } from '@opsen/base-ops'
import { VaultFactStore } from '../vault-fact-store.js'
import { VaultKV2Client } from '../vault-client.js'

vi.mock('../vault-client.js')

function makeFact(kind: string, name: string, owner = 'test-stack'): InfrastructureFact {
  return { kind, metadata: { name }, spec: { value: `${kind}-${name}` }, owner }
}

describe('VaultFactStore', () => {
  let mockClient: {
    get: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    }
    vi.mocked(VaultKV2Client).mockImplementation(() => mockClient as unknown as VaultKV2Client)
  })

  describe('read', () => {
    it('enumerates owners, kinds, and names to build facts', async () => {
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'my-stack') return ['cluster/', 'database/']
        if (path === 'my-stack/cluster') return ['prod']
        if (path === 'my-stack/database') return ['main']
        return ['my-stack/']
      })
      mockClient.get.mockImplementation(async (path: string) => {
        if (path === 'my-stack/cluster/prod') return makeFact('cluster', 'prod')
        if (path === 'my-stack/database/main') return makeFact('database', 'main')
        return null
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' })
      const config = await store.read()

      expect(config.facts).toHaveLength(2)
      expect(config.facts.map((f) => f.kind).sort()).toEqual(['cluster', 'database'])
    })

    it('reads facts from multiple owners', async () => {
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'owner-a') return ['cluster/']
        if (path === 'owner-b') return ['database/']
        if (path === 'owner-a/cluster') return ['prod']
        if (path === 'owner-b/database') return ['main']
        return ['owner-a/', 'owner-b/']
      })
      mockClient.get.mockImplementation(async (path: string) => {
        if (path === 'owner-a/cluster/prod') return makeFact('cluster', 'prod', 'owner-a')
        if (path === 'owner-b/database/main') return makeFact('database', 'main', 'owner-b')
        return null
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' })
      const config = await store.read()

      expect(config.facts).toHaveLength(2)
      expect(config.facts.map((f) => f.kind).sort()).toEqual(['cluster', 'database'])
    })

    it('skips null results from get', async () => {
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'my-stack') return ['cluster/']
        if (path === 'my-stack/cluster') return ['prod']
        return ['my-stack/']
      })
      mockClient.get.mockResolvedValue(null)

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' })
      const config = await store.read()

      expect(config.facts).toHaveLength(0)
    })

    it('returns empty facts when no owners exist', async () => {
      mockClient.list.mockResolvedValue([])

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' })
      const config = await store.read()

      expect(config.facts).toHaveLength(0)
    })

    it('reads with basePath prefix when configured', async () => {
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'infra') return ['my-stack/']
        if (path === 'infra/my-stack') return ['cluster/']
        if (path === 'infra/my-stack/cluster') return ['prod']
        return []
      })
      mockClient.get.mockImplementation(async (path: string) => {
        if (path === 'infra/my-stack/cluster/prod') return makeFact('cluster', 'prod')
        return null
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok', basePath: 'infra' })
      const config = await store.read()

      expect(config.facts).toHaveLength(1)
      expect(mockClient.list).toHaveBeenCalledWith('infra')
    })
  })

  describe('write', () => {
    it('writes facts under the owner path at mount root', async () => {
      mockClient.put.mockResolvedValue(undefined)
      mockClient.list.mockResolvedValue([])

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'my-stack')
      await store.write({
        facts: [makeFact('cluster', 'prod', 'my-stack'), makeFact('database', 'main', 'my-stack')],
      })

      expect(mockClient.put).toHaveBeenCalledWith('my-stack/cluster/prod', expect.objectContaining({ kind: 'cluster' }))
      expect(mockClient.put).toHaveBeenCalledWith(
        'my-stack/database/main',
        expect.objectContaining({ kind: 'database' }),
      )
    })

    it('throws when no owner is set', async () => {
      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' })

      await expect(store.write({ facts: [] })).rejects.toThrow('Owner is required for write operations')
    })

    it('cleans up stale facts by listing the owner directory', async () => {
      mockClient.put.mockResolvedValue(undefined)
      mockClient.delete.mockResolvedValue(undefined)
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'my-stack') return ['cluster/']
        if (path === 'my-stack/cluster') return ['prod', 'old-staging']
        return []
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'my-stack')
      await store.write({
        facts: [makeFact('cluster', 'prod', 'my-stack')],
      })

      expect(mockClient.delete).toHaveBeenCalledWith('my-stack/cluster/old-staging')
      expect(mockClient.delete).toHaveBeenCalledTimes(1)
    })

    it('skips cleanup when cleanupStale is false', async () => {
      mockClient.put.mockResolvedValue(undefined)

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok', cleanupStale: false }, 'my-stack')
      await store.write({ facts: [makeFact('cluster', 'prod', 'my-stack')] })

      expect(mockClient.list).not.toHaveBeenCalled()
      expect(mockClient.delete).not.toHaveBeenCalled()
    })

    it('does not delete facts that were just written', async () => {
      mockClient.put.mockResolvedValue(undefined)
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'my-stack') return ['cluster/']
        if (path === 'my-stack/cluster') return ['prod']
        return []
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'my-stack')
      await store.write({ facts: [makeFact('cluster', 'prod', 'my-stack')] })

      expect(mockClient.delete).not.toHaveBeenCalled()
    })

    it('writes with basePath prefix when configured', async () => {
      mockClient.put.mockResolvedValue(undefined)
      mockClient.list.mockResolvedValue([])

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok', basePath: 'infra' }, 'my-stack')
      await store.write({ facts: [makeFact('cluster', 'prod', 'my-stack')] })

      expect(mockClient.put).toHaveBeenCalledWith(
        'infra/my-stack/cluster/prod',
        expect.objectContaining({ kind: 'cluster' }),
      )
    })
  })

  describe('simple secrets', () => {
    it('reads simple secrets as raw { value } with owner from path', async () => {
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'manual') return ['secret/']
        if (path === 'my-stack') return ['cluster/']
        if (path === 'manual/secret') return ['db-password', 'api-key']
        if (path === 'my-stack/cluster') return ['prod']
        return ['manual/', 'my-stack/']
      })
      mockClient.get.mockImplementation(async (path: string) => {
        if (path === 'manual/secret/db-password') return { value: 'hunter2' }
        if (path === 'manual/secret/api-key') return { value: 's3cr3t' }
        if (path === 'my-stack/cluster/prod') return makeFact('cluster', 'prod', 'my-stack')
        return null
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' })
      const config = await store.read()

      expect(config.facts).toHaveLength(3)

      const secrets = config.facts.filter((f) => f.kind === SIMPLE_SECRET_KIND)
      expect(secrets).toHaveLength(2)
      expect(secrets).toEqual(
        expect.arrayContaining([
          { kind: 'secret', metadata: { name: 'db-password' }, spec: { value: 'hunter2' }, owner: 'manual' },
          { kind: 'secret', metadata: { name: 'api-key' }, spec: { value: 's3cr3t' }, owner: 'manual' },
        ]),
      )
    })

    it('writes simple secrets as raw { value }', async () => {
      mockClient.put.mockResolvedValue(undefined)
      mockClient.list.mockResolvedValue([])

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'manual')
      await store.write({
        facts: [simpleSecret('db-password', 'hunter2', 'manual'), makeFact('cluster', 'prod')],
      })

      expect(mockClient.put).toHaveBeenCalledWith('manual/secret/db-password', { value: 'hunter2' })
      expect(mockClient.put).toHaveBeenCalledWith('manual/cluster/prod', expect.objectContaining({ kind: 'cluster' }))
    })

    it('cleans up stale simple secrets via directory listing', async () => {
      mockClient.put.mockResolvedValue(undefined)
      mockClient.delete.mockResolvedValue(undefined)
      mockClient.list.mockImplementation(async (path: string) => {
        if (path === 'manual') return ['secret/']
        if (path === 'manual/secret') return ['db-password', 'old-key']
        return []
      })

      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'manual')
      await store.write({
        facts: [simpleSecret('db-password', 'hunter2', 'manual')],
      })

      expect(mockClient.delete).toHaveBeenCalledWith('manual/secret/old-key')
      expect(mockClient.delete).toHaveBeenCalledTimes(1)
    })
  })

  describe('validation', () => {
    it('rejects invalid owner names', () => {
      expect(() => new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'org/project')).toThrow(
        'not a valid Vault path segment',
      )
    })

    it('accepts valid owner names', () => {
      expect(() => new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'my-stack')).not.toThrow()
    })

    it('rejects invalid kind on write', async () => {
      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'my-stack')

      await expect(store.write({ facts: [makeFact('a/b', 'prod')] })).rejects.toThrow('Kind "a/b"')
    })

    it('rejects invalid name on write', async () => {
      const store = new VaultFactStore({ address: 'https://vault', token: 'tok' }, 'my-stack')

      await expect(store.write({ facts: [makeFact('cluster', 'a#b')] })).rejects.toThrow('Name "a#b"')
    })
  })

  describe('options', () => {
    it('uses custom mount', () => {
      new VaultFactStore({ address: 'https://vault', token: 'tok', mount: 'custom' })

      expect(VaultKV2Client).toHaveBeenCalledWith(expect.objectContaining({ mount: 'custom' }))
    })

    it('defaults mount to opsen', () => {
      new VaultFactStore({ address: 'https://vault', token: 'tok' })

      expect(VaultKV2Client).toHaveBeenCalledWith(expect.objectContaining({ mount: 'opsen' }))
    })
  })
})
