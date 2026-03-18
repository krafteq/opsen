import type { FactStoreReader, FactStoreWriter, InfrastructureConfig, InfrastructureFact } from '@opsen/base-ops'
import type { AzureFactStoreOptions } from './types'
import { encodeSecretName, validateFactKey } from './secret-naming'

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
  private readonly owner: string | undefined
  private readonly cleanupStale: boolean

  constructor(options: AzureFactStoreOptions) {
    this.vaultUrl = options.vaultUrl
    this.credential = options.credential
    this.owner = options.owner
    this.cleanupStale = options.cleanupStale ?? true
    if (this.owner) {
      validateFactKey('Owner', this.owner)
    }
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
    const prefix = this.owner ? `${this.owner}--` : undefined

    for await (const properties of client.listPropertiesOfSecrets()) {
      if (prefix && !properties.name.startsWith(prefix)) continue

      const secret = await client.getSecret(properties.name)
      if (!secret.value) continue

      const fact = tryParseFact(secret.value)
      if (fact) facts.push(fact)
    }

    return { facts }
  }

  async write(config: InfrastructureConfig): Promise<void> {
    const client = await this.getClient()

    for (const fact of config.facts) {
      validateFactKey('Kind', fact.kind)
      validateFactKey('Name', fact.metadata.name)
    }

    const writtenNames = new Set<string>()

    const writes = config.facts.map(async (fact) => {
      const secretName = encodeSecretName(this.owner, fact.kind, fact.metadata.name)
      const value = JSON.stringify(fact)
      try {
        await client.setSecret(secretName, value)
      } catch (err: unknown) {
        if (isConflictError(err)) {
          await this.recoverAndSet(client, secretName, value)
        } else {
          throw err
        }
      }
      writtenNames.add(secretName)
    })
    await Promise.all(writes)

    if (this.owner && this.cleanupStale) {
      const prefix = `${this.owner}--`
      for await (const properties of client.listPropertiesOfSecrets()) {
        if (!properties.name.startsWith(prefix)) continue
        if (writtenNames.has(properties.name)) continue
        const poller = await client.beginDeleteSecret(properties.name)
        await poller.pollUntilDone()
      }
    }
  }

  /** Recover a soft-deleted secret then overwrite it. */
  private async recoverAndSet(client: SecretClientLike, name: string, value: string): Promise<void> {
    const poller = await client.beginRecoverDeletedSecret(name)
    await poller.pollUntilDone()
    await client.setSecret(name, value)
  }
}

function tryParseFact(value: string): InfrastructureFact | null {
  try {
    const parsed = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.kind === 'string' &&
      parsed.metadata?.name &&
      parsed.spec
    ) {
      return parsed as InfrastructureFact
    }
    return null
  } catch {
    return null
  }
}

function isConflictError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 409
  )
}
