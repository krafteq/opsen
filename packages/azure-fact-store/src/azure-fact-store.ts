import type { FactStoreReader, FactStoreWriter, InfrastructureConfig, InfrastructureFact } from '@opsen/base-ops'
import { SIMPLE_SECRET_KIND } from '@opsen/base-ops'
import type { AzureFactStoreOptions } from './types.js'
import { encodeSecretName, decodeSecretName, manifestSecretName, validateFactKey } from './secret-naming.js'

interface Manifest {
  secretNames: string[]
  lastUpdated: string
}

/** Minimal interface for the Azure SecretClient methods we use. */
interface SecretClientLike {
  listPropertiesOfSecrets(): AsyncIterable<{ name: string }>
  getSecret(name: string): Promise<{ value?: string }>
  setSecret(name: string, value: string): Promise<unknown>
  beginDeleteSecret(name: string): Promise<{ pollUntilDone(): Promise<unknown> }>
  beginRecoverDeletedSecret(name: string): Promise<{ pollUntilDone(): Promise<unknown> }>
}

export class AzureFactStore implements FactStoreReader, FactStoreWriter {
  private client: SecretClientLike | undefined
  private readonly vaultUrl: string
  private readonly credential: AzureFactStoreOptions['credential']
  private readonly prefix: string
  private readonly cleanupStale: boolean
  private readonly owner: string | undefined

  constructor(options: AzureFactStoreOptions, owner?: string) {
    this.vaultUrl = options.vaultUrl
    this.credential = options.credential
    this.prefix = options.prefix ?? 'opsen'
    this.cleanupStale = options.cleanupStale ?? true
    this.owner = owner
  }

  private async getClient(): Promise<SecretClientLike> {
    if (this.client) return this.client
    const { SecretClient } = await import('@azure/keyvault-secrets')
    const credential = this.credential ?? (await this.getDefaultCredential())
    this.client = new SecretClient(this.vaultUrl, credential)
    return this.client
  }

  private async getDefaultCredential(): Promise<import('@azure/identity').TokenCredential> {
    const { DefaultAzureCredential } = await import('@azure/identity')
    return new DefaultAzureCredential()
  }

  async read(): Promise<InfrastructureConfig> {
    const client = await this.getClient()
    const facts: InfrastructureFact[] = []
    const prefix = `${this.prefix}-`

    for await (const properties of client.listPropertiesOfSecrets()) {
      if (!properties.name.startsWith(prefix)) continue
      if (properties.name.startsWith(`${this.prefix}-manifest-`)) continue

      const decoded = decodeSecretName(this.prefix, properties.name)
      if (!decoded) continue

      const secret = await client.getSecret(properties.name)
      if (secret.value) {
        if (decoded.kind === SIMPLE_SECRET_KIND) {
          facts.push({
            kind: SIMPLE_SECRET_KIND,
            metadata: { name: decoded.name },
            spec: { value: secret.value },
            owner: '',
          })
        } else {
          facts.push(JSON.parse(secret.value) as InfrastructureFact)
        }
      }
    }

    return { facts }
  }

  async write(config: InfrastructureConfig): Promise<void> {
    const client = await this.getClient()
    const writtenNames: string[] = []

    for (const fact of config.facts) {
      validateFactKey('Kind', fact.kind)
      validateFactKey('Name', fact.metadata.name)
    }

    const writes = config.facts.map(async (fact) => {
      const secretName = encodeSecretName(this.prefix, fact.kind, fact.metadata.name)
      const value = fact.kind === SIMPLE_SECRET_KIND ? (fact.spec as { value: string }).value : JSON.stringify(fact)
      try {
        await client.setSecret(secretName, value)
      } catch (err: unknown) {
        if (isConflictError(err)) {
          await this.recoverAndSet(client, secretName, value)
        } else {
          throw err
        }
      }
      writtenNames.push(secretName)
    })
    await Promise.all(writes)

    if (this.owner) {
      const mName = manifestSecretName(this.prefix, this.owner)
      let oldManifest: Manifest | null = null
      try {
        const secret = await client.getSecret(mName)
        if (secret.value) {
          oldManifest = JSON.parse(secret.value) as Manifest
        }
      } catch {
        // Manifest doesn't exist yet
      }

      if (this.cleanupStale && oldManifest?.secretNames) {
        const writtenSet = new Set(writtenNames)
        const staleNames = oldManifest.secretNames.filter((n) => !writtenSet.has(n))
        await Promise.all(
          staleNames.map(async (name) => {
            const poller = await client.beginDeleteSecret(name)
            await poller.pollUntilDone()
          }),
        )
      }

      const manifest: Manifest = {
        secretNames: writtenNames,
        lastUpdated: new Date().toISOString(),
      }
      await client.setSecret(mName, JSON.stringify(manifest))
    }
  }

  /** Recover a soft-deleted secret then overwrite it. */
  private async recoverAndSet(client: SecretClientLike, name: string, value: string): Promise<void> {
    const poller = await client.beginRecoverDeletedSecret(name)
    await poller.pollUntilDone()
    await client.setSecret(name, value)
  }
}

function isConflictError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 409
  )
}
