import { describe, it, expect, afterAll } from 'vitest'
import { SIMPLE_SECRET_KIND, simpleSecret } from '@opsen/base-ops'
import type { InfrastructureFact } from '@opsen/base-ops'
import { AzureFactStore } from '../azure-fact-store.js'

const VAULT_URL = 'https://AZURE_KEYVAULT_NAME_PLACEHOLDER.vault.azure.net/'
const RUN_ID = Date.now()
let testCounter = 0

function uniqueOwner() {
  return `e2e-${RUN_ID}-${testCounter++}`
}

function makeFact(kind: string, name: string, owner = 'e2e-test'): InfrastructureFact {
  return { kind, metadata: { name }, spec: { value: `${kind}-${name}` }, owner }
}

/** Purge all secrets matching any owner prefix from this run */
async function cleanupRun() {
  const { SecretClient } = await import('@azure/keyvault-secrets')
  const { DefaultAzureCredential } = await import('@azure/identity')
  const client = new SecretClient(VAULT_URL, new DefaultAzureCredential())
  const tag = `e2e-${RUN_ID}-`

  for await (const props of client.listPropertiesOfSecrets()) {
    if (props.name.startsWith(tag)) {
      try {
        const poller = await client.beginDeleteSecret(props.name)
        await poller.pollUntilDone()
      } catch {
        // already deleted
      }
    }
  }

  for await (const props of client.listDeletedSecrets()) {
    if (props.name.startsWith(tag)) {
      try {
        await client.purgeDeletedSecret(props.name)
      } catch {
        // already purged
      }
    }
  }
}

afterAll(cleanupRun, 120_000)

describe('AzureFactStore e2e', () => {
  it('write and read back facts', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })
    const facts = [makeFact('cluster', 'prod'), makeFact('database', 'main')]

    await store.write({ facts })

    const config = await store.read()
    expect(config.facts).toHaveLength(2)

    const kinds = config.facts.map((f) => f.kind).sort()
    expect(kinds).toEqual(['cluster', 'database'])

    const clusterFact = config.facts.find((f) => f.kind === 'cluster')
    expect(clusterFact).toEqual(makeFact('cluster', 'prod', 'e2e-test'))
  })

  it('write and read simple secrets as JSON', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })
    const secret = simpleSecret('db-password', 's3cret-val', 'e2e-test')
    const regular = makeFact('cluster', 'staging')

    await store.write({ facts: [secret, regular] })

    const config = await store.read()
    expect(config.facts).toHaveLength(2)

    const secretFact = config.facts.find((f) => f.kind === SIMPLE_SECRET_KIND)
    expect(secretFact).toBeDefined()
    expect(secretFact!.spec).toEqual({ value: 's3cret-val' })
    expect(secretFact!.metadata.name).toBe('db-password')
  })

  it('overwrite existing facts', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })

    await store.write({ facts: [makeFact('cluster', 'prod')] })
    const v1 = await store.read()
    expect(v1.facts).toHaveLength(1)
    expect(v1.facts[0].spec).toEqual({ value: 'cluster-prod' })

    const updatedFact: InfrastructureFact = {
      kind: 'cluster',
      metadata: { name: 'prod' },
      spec: { value: 'updated-value' },
      owner: 'e2e-test',
    }
    await store.write({ facts: [updatedFact] })

    const v2 = await store.read()
    expect(v2.facts).toHaveLength(1)
    expect(v2.facts[0].spec).toEqual({ value: 'updated-value' })
  })

  it('cleans up stale secrets using owner prefix', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })

    // Write two facts
    await store.write({ facts: [makeFact('cluster', 'prod'), makeFact('cluster', 'staging')] })
    const v1 = await store.read()
    expect(v1.facts).toHaveLength(2)

    // Write only one — the other should get cleaned up
    await store.write({ facts: [makeFact('cluster', 'prod')] })

    // Give Key Vault a moment to process the delete
    await new Promise((r) => setTimeout(r, 2000))

    const v2 = await store.read()
    expect(v2.facts).toHaveLength(1)
    expect(v2.facts[0].metadata.name).toBe('prod')
  })

  it('read returns empty when no facts exist', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })
    const config = await store.read()
    expect(config.facts).toHaveLength(0)
  })

  it('recover soft-deleted secret on conflict (write after delete)', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })

    // Write a fact
    await store.write({ facts: [makeFact('cluster', 'ephemeral')] })

    // Remove it via stale cleanup by writing empty set
    await store.write({ facts: [] })

    // Give soft-delete time to register
    await new Promise((r) => setTimeout(r, 2000))

    // Write the same key again — should trigger 409 → recover → set
    await store.write({ facts: [makeFact('cluster', 'ephemeral')] })

    const config = await store.read()
    const found = config.facts.find((f) => f.kind === 'cluster' && f.metadata.name === 'ephemeral')
    expect(found).toBeDefined()
  })

  it('validation rejects invalid characters', async () => {
    const owner = uniqueOwner()
    const store = new AzureFactStore({ vaultUrl: VAULT_URL, owner })
    await expect(store.write({ facts: [makeFact('bad/kind', 'name')] })).rejects.toThrow('Kind "bad/kind"')
    await expect(store.write({ facts: [makeFact('kind', 'bad#name')] })).rejects.toThrow('Name "bad#name"')
  })
})
