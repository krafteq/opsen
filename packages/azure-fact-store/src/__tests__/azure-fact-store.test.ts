import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InfrastructureFact } from '@opsen/base-ops'
import { SIMPLE_SECRET_KIND, simpleSecret } from '@opsen/base-ops'
import { AzureFactStore } from '../azure-fact-store.js'
import { encodeSecretName } from '../secret-naming.js'

function makeFact(kind: string, name: string, owner = 'test-stack'): InfrastructureFact {
  return { kind, metadata: { name }, spec: { value: `${kind}-${name}` }, owner }
}

function makeSecretProperties(name: string) {
  return { name }
}

function makeSecret(name: string, value: string) {
  return { name, value }
}

describe('AzureFactStore', () => {
  let mockSecretClient: {
    listPropertiesOfSecrets: ReturnType<typeof vi.fn>
    getSecret: ReturnType<typeof vi.fn>
    setSecret: ReturnType<typeof vi.fn>
    beginDeleteSecret: ReturnType<typeof vi.fn>
    beginRecoverDeletedSecret: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockSecretClient = {
      listPropertiesOfSecrets: vi.fn(),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      beginDeleteSecret: vi.fn(),
      beginRecoverDeletedSecret: vi.fn(),
    }

    vi.doMock('@azure/keyvault-secrets', () => ({
      SecretClient: vi.fn().mockImplementation(() => mockSecretClient),
    }))
  })

  function createStore(owner?: string) {
    const store = new AzureFactStore({
      vaultUrl: 'https://test.vault.azure.net/',
      credential: { getToken: vi.fn() } as any,
      owner,
    })
    // Inject mock client directly
    ;(store as any).client = mockSecretClient
    return store
  }

  describe('read', () => {
    it('reads facts by listing and parsing JSON values', async () => {
      const clusterFact = makeFact('cluster', 'prod')
      const dbFact = makeFact('database', 'main')
      const clusterSecretName = encodeSecretName('myapp', 'cluster', 'prod')
      const dbSecretName = encodeSecretName('myapp', 'database', 'main')

      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties(clusterSecretName)
          yield makeSecretProperties(dbSecretName)
        })(),
      )
      mockSecretClient.getSecret.mockImplementation(async (name: string) => {
        if (name === clusterSecretName) return makeSecret(name, JSON.stringify(clusterFact))
        if (name === dbSecretName) return makeSecret(name, JSON.stringify(dbFact))
        return makeSecret(name, '')
      })

      const store = createStore('myapp')
      const config = await store.read()

      expect(config.facts).toHaveLength(2)
      expect(config.facts.map((f) => f.kind).sort()).toEqual(['cluster', 'database'])
    })

    it('skips non-fact secrets (invalid JSON)', async () => {
      const clusterFact = makeFact('cluster', 'prod')
      const clusterSecretName = encodeSecretName('myapp', 'cluster', 'prod')

      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties(clusterSecretName)
          yield makeSecretProperties('myapp--some--raw-value')
        })(),
      )
      mockSecretClient.getSecret.mockImplementation(async (name: string) => {
        if (name === clusterSecretName) return makeSecret(name, JSON.stringify(clusterFact))
        return makeSecret(name, 'not-json')
      })

      const store = createStore('myapp')
      const config = await store.read()

      expect(config.facts).toHaveLength(1)
      expect(config.facts[0].kind).toBe('cluster')
    })

    it('skips secrets without required fact fields', async () => {
      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties('myapp--something--else')
        })(),
      )
      mockSecretClient.getSecret.mockResolvedValue(makeSecret('myapp--something--else', JSON.stringify({ foo: 'bar' })))

      const store = createStore('myapp')
      const config = await store.read()

      expect(config.facts).toHaveLength(0)
    })

    it('filters by owner prefix', async () => {
      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties('other--cluster--prod')
          yield makeSecretProperties('myapp--cluster--prod')
        })(),
      )
      mockSecretClient.getSecret.mockResolvedValue(
        makeSecret('myapp--cluster--prod', JSON.stringify(makeFact('cluster', 'prod'))),
      )

      const store = createStore('myapp')
      const config = await store.read()

      expect(config.facts).toHaveLength(1)
      expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(1)
    })

    it('reads all secrets when no owner is set', async () => {
      const clusterFact = makeFact('cluster', 'prod')

      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties('cluster--prod')
          yield makeSecretProperties('unrelated-secret')
        })(),
      )
      mockSecretClient.getSecret.mockImplementation(async (name: string) => {
        if (name === 'cluster--prod') return makeSecret(name, JSON.stringify(clusterFact))
        return makeSecret(name, 'plain-text')
      })

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(1)
      expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(2)
    })

    it('returns empty facts when no secrets exist', async () => {
      mockSecretClient.listPropertiesOfSecrets.mockReturnValue((async function* () {})())

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(0)
    })
  })

  describe('write', () => {
    it('writes all facts as JSON', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      const facts = [makeFact('cluster', 'prod'), makeFact('database', 'main')]
      await store.write({ facts })

      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(2)
      for (const fact of facts) {
        const secretName = encodeSecretName(undefined, fact.kind, fact.metadata.name)
        expect(mockSecretClient.setSecret).toHaveBeenCalledWith(secretName, JSON.stringify(fact))
      }
    })

    it('writes simple secrets as JSON like any other fact', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      const secret = simpleSecret('db-password', 'hunter2', 'manual')
      await store.write({ facts: [secret] })

      const secretName = encodeSecretName(undefined, SIMPLE_SECRET_KIND, 'db-password')
      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(secretName, JSON.stringify(secret))
    })

    it('cleans up stale secrets using owner prefix listing', async () => {
      const keepName = encodeSecretName('myapp', 'cluster', 'prod')
      const staleName = encodeSecretName('myapp', 'cluster', 'old-staging')

      mockSecretClient.setSecret.mockResolvedValue({})
      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties(keepName)
          yield makeSecretProperties(staleName)
          yield makeSecretProperties('other--cluster--prod') // different owner
        })(),
      )
      mockSecretClient.beginDeleteSecret.mockResolvedValue({ pollUntilDone: vi.fn().mockResolvedValue({}) })

      const store = createStore('myapp')
      await store.write({ facts: [makeFact('cluster', 'prod', 'myapp')] })

      expect(mockSecretClient.beginDeleteSecret).toHaveBeenCalledWith(staleName)
      expect(mockSecretClient.beginDeleteSecret).toHaveBeenCalledTimes(1)
    })

    it('skips cleanup when no owner is set', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      await store.write({ facts: [makeFact('cluster', 'prod')] })

      expect(mockSecretClient.beginDeleteSecret).not.toHaveBeenCalled()
      expect(mockSecretClient.listPropertiesOfSecrets).not.toHaveBeenCalled()
    })

    it('skips cleanup when cleanupStale is false', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = new AzureFactStore({
        vaultUrl: 'https://test.vault.azure.net/',
        credential: { getToken: vi.fn() } as any,
        owner: 'myapp',
        cleanupStale: false,
      })
      ;(store as any).client = mockSecretClient

      await store.write({ facts: [makeFact('cluster', 'prod', 'myapp')] })

      expect(mockSecretClient.beginDeleteSecret).not.toHaveBeenCalled()
    })

    it('recovers soft-deleted secret on 409 conflict', async () => {
      const secretName = encodeSecretName(undefined, 'cluster', 'prod')

      mockSecretClient.setSecret.mockRejectedValueOnce({ statusCode: 409, message: 'Conflict' }).mockResolvedValue({})
      mockSecretClient.beginRecoverDeletedSecret.mockResolvedValue({
        pollUntilDone: vi.fn().mockResolvedValue({}),
      })

      const store = createStore()
      await store.write({ facts: [makeFact('cluster', 'prod')] })

      expect(mockSecretClient.beginRecoverDeletedSecret).toHaveBeenCalledWith(secretName)
      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(2)
    })
  })

  describe('validation', () => {
    it('rejects invalid kind on write', async () => {
      const store = createStore()
      await expect(store.write({ facts: [makeFact('a/b', 'prod')] })).rejects.toThrow('Kind "a/b"')
    })

    it('rejects invalid name on write', async () => {
      const store = createStore()
      await expect(store.write({ facts: [makeFact('cluster', 'a#b')] })).rejects.toThrow('Name "a#b"')
    })

    it('rejects dots in kind', async () => {
      const store = createStore()
      await expect(store.write({ facts: [makeFact('cluster.v2', 'prod')] })).rejects.toThrow('Kind "cluster.v2"')
    })

    it('rejects owner with invalid characters', () => {
      expect(() => new AzureFactStore({ vaultUrl: 'https://test.vault.azure.net/', owner: 'my/owner' })).toThrow(
        'Owner "my/owner"',
      )
    })

    it('accepts valid kind and name on write', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      await store.write({ facts: [makeFact('cluster', 'prod-v2')] })

      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(1)
    })
  })
})
