import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InfrastructureFact } from '@opsen/base-ops'
import { SIMPLE_SECRET_KIND, simpleSecret } from '@opsen/base-ops'
import { AzureFactStore } from '../azure-fact-store.js'
import { encodeSecretName, manifestSecretName } from '../secret-naming.js'

function makeFact(kind: string, name: string, owner = 'test/stack'): InfrastructureFact {
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
    const store = new AzureFactStore(
      {
        vaultUrl: 'https://test.vault.azure.net/',
        credential: { getToken: vi.fn() } as any,
        prefix: 'opsen',
      },
      owner,
    )
    // Inject mock client directly
    ;(store as any).client = mockSecretClient
    return store
  }

  describe('read', () => {
    it('reads facts by listing and filtering secrets', async () => {
      const clusterFact = makeFact('cluster', 'prod')
      const dbFact = makeFact('database', 'main')
      const clusterSecretName = encodeSecretName('opsen', 'cluster', 'prod')
      const dbSecretName = encodeSecretName('opsen', 'database', 'main')

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

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(2)
      expect(config.facts.map((f) => f.kind).sort()).toEqual(['cluster', 'database'])
    })

    it('skips manifest secrets', async () => {
      const clusterFact = makeFact('cluster', 'prod')
      const clusterSecretName = encodeSecretName('opsen', 'cluster', 'prod')
      const mName = manifestSecretName('opsen', 'some-owner')

      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties(clusterSecretName)
          yield makeSecretProperties(mName)
        })(),
      )
      mockSecretClient.getSecret.mockResolvedValue(makeSecret(clusterSecretName, JSON.stringify(clusterFact)))

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(1)
    })

    it('skips secrets with wrong prefix', async () => {
      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties('other-secret')
        })(),
      )

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(0)
      expect(mockSecretClient.getSecret).not.toHaveBeenCalled()
    })

    it('returns empty facts when no secrets exist', async () => {
      mockSecretClient.listPropertiesOfSecrets.mockReturnValue((async function* () {})())

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(0)
    })
  })

  describe('write', () => {
    it('writes all facts as secrets', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      const facts = [makeFact('cluster', 'prod'), makeFact('database', 'main')]
      await store.write({ facts })

      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(2)
      for (const fact of facts) {
        const secretName = encodeSecretName('opsen', fact.kind, fact.metadata.name)
        expect(mockSecretClient.setSecret).toHaveBeenCalledWith(secretName, JSON.stringify(fact))
      }
    })

    it('writes manifest and cleans up stale secrets when owner is set', async () => {
      const staleName = encodeSecretName('opsen', 'cluster', 'old-staging')
      const keepName = encodeSecretName('opsen', 'cluster', 'prod')
      const mName = manifestSecretName('opsen', 'my/owner')

      mockSecretClient.setSecret.mockResolvedValue({})
      mockSecretClient.getSecret.mockResolvedValue(
        makeSecret(
          mName,
          JSON.stringify({ secretNames: [keepName, staleName], lastUpdated: '2024-01-01T00:00:00.000Z' }),
        ),
      )
      mockSecretClient.beginDeleteSecret.mockResolvedValue({ pollUntilDone: vi.fn().mockResolvedValue({}) })

      const store = createStore('my/owner')
      await store.write({ facts: [makeFact('cluster', 'prod', 'my/owner')] })

      expect(mockSecretClient.beginDeleteSecret).toHaveBeenCalledWith(staleName)
      expect(mockSecretClient.beginDeleteSecret).toHaveBeenCalledTimes(1)
    })

    it('skips cleanup when cleanupStale is false', async () => {
      const mName = manifestSecretName('opsen', 'my/owner')

      mockSecretClient.setSecret.mockResolvedValue({})
      mockSecretClient.getSecret.mockResolvedValue(
        makeSecret(mName, JSON.stringify({ secretNames: ['stale'], lastUpdated: '2024-01-01T00:00:00.000Z' })),
      )

      const store = new AzureFactStore(
        {
          vaultUrl: 'https://test.vault.azure.net/',
          credential: { getToken: vi.fn() } as any,
          prefix: 'opsen',
          cleanupStale: false,
        },
        'my/owner',
      )
      ;(store as any).client = mockSecretClient

      await store.write({ facts: [makeFact('cluster', 'prod', 'my/owner')] })

      expect(mockSecretClient.beginDeleteSecret).not.toHaveBeenCalled()
    })

    it('does not write manifest when no owner is set', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      await store.write({ facts: [makeFact('cluster', 'prod')] })

      // Only fact write, no manifest
      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(1)
      expect(mockSecretClient.getSecret).not.toHaveBeenCalled()
    })

    it('recovers soft-deleted secret on 409 conflict', async () => {
      const secretName = encodeSecretName('opsen', 'cluster', 'prod')

      mockSecretClient.setSecret.mockRejectedValueOnce({ statusCode: 409, message: 'Conflict' }).mockResolvedValue({})
      mockSecretClient.beginRecoverDeletedSecret.mockResolvedValue({
        pollUntilDone: vi.fn().mockResolvedValue({}),
      })

      const store = createStore()
      await store.write({ facts: [makeFact('cluster', 'prod')] })

      expect(mockSecretClient.beginRecoverDeletedSecret).toHaveBeenCalledWith(secretName)
      // setSecret called twice: first fails with 409, then succeeds after recovery
      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(2)
    })

    it('handles missing manifest on first write', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})
      mockSecretClient.getSecret.mockRejectedValue(new Error('SecretNotFound'))

      const store = createStore('my/owner')
      await store.write({ facts: [makeFact('cluster', 'prod', 'my/owner')] })

      expect(mockSecretClient.beginDeleteSecret).not.toHaveBeenCalled()
      // Fact + manifest
      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(2)
    })
  })

  describe('simple secrets', () => {
    it('reads simple secrets as raw values reconstructing the fact', async () => {
      const secretSecretName = encodeSecretName('opsen', SIMPLE_SECRET_KIND, 'db-password')
      const clusterSecretName = encodeSecretName('opsen', 'cluster', 'prod')
      const clusterFact = makeFact('cluster', 'prod')

      mockSecretClient.listPropertiesOfSecrets.mockReturnValue(
        (async function* () {
          yield makeSecretProperties(secretSecretName)
          yield makeSecretProperties(clusterSecretName)
        })(),
      )
      mockSecretClient.getSecret.mockImplementation(async (name: string) => {
        if (name === secretSecretName) return makeSecret(name, 'hunter2')
        if (name === clusterSecretName) return makeSecret(name, JSON.stringify(clusterFact))
        return makeSecret(name, '')
      })

      const store = createStore()
      const config = await store.read()

      expect(config.facts).toHaveLength(2)

      const secrets = config.facts.filter((f) => f.kind === SIMPLE_SECRET_KIND)
      expect(secrets).toHaveLength(1)
      expect(secrets[0]).toEqual({
        kind: SIMPLE_SECRET_KIND,
        metadata: { name: 'db-password' },
        spec: { value: 'hunter2' },
        owner: '',
      })
    })

    it('writes simple secrets as raw values', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      await store.write({
        facts: [simpleSecret('db-password', 'hunter2', 'manual'), makeFact('cluster', 'prod')],
      })

      const secretName = encodeSecretName('opsen', SIMPLE_SECRET_KIND, 'db-password')
      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(secretName, 'hunter2')

      const clusterName = encodeSecretName('opsen', 'cluster', 'prod')
      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(clusterName, JSON.stringify(makeFact('cluster', 'prod')))
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

    it('accepts valid kind and name on write', async () => {
      mockSecretClient.setSecret.mockResolvedValue({})

      const store = createStore()
      await store.write({ facts: [makeFact('cluster', 'prod-v2.0')] })

      expect(mockSecretClient.setSecret).toHaveBeenCalledTimes(1)
    })
  })
})
