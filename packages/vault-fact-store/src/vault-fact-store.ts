import type { FactStoreReader, FactStoreWriter, InfrastructureConfig, InfrastructureFact } from '@opsen/base-ops'
import { SIMPLE_SECRET_KIND } from '@opsen/base-ops'
import { VaultKV2Client } from './vault-client.js'
import { factPath, joinPath, validatePathSegment } from './secret-naming.js'
import type { VaultFactStoreOptions } from './types.js'

export class VaultFactStore implements FactStoreReader, FactStoreWriter {
  private readonly client: VaultKV2Client
  private readonly basePath: string | undefined
  private readonly cleanupStale: boolean
  private readonly owner: string | undefined
  private readonly owners: Set<string> | undefined

  constructor(options: VaultFactStoreOptions, owner?: string) {
    if (owner) validatePathSegment('Owner', owner)

    this.client = new VaultKV2Client({
      address: options.address,
      token: options.token,
      namespace: options.namespace,
      mount: options.mount ?? 'opsen',
    })
    this.basePath = options.basePath
    this.cleanupStale = options.cleanupStale ?? true
    this.owners = options.owners ? new Set(options.owners) : undefined
    this.owner = owner
  }

  async read(): Promise<InfrastructureConfig> {
    const owners = await this.client.list(joinPath(this.basePath))
    const facts: InfrastructureFact[] = []

    for (const ownerKey of owners) {
      const owner = ownerKey.replace(/\/$/, '')
      if (this.owners && !this.owners.has(owner)) continue

      let kinds: string[]
      try {
        kinds = await this.client.list(joinPath(this.basePath, owner))
      } catch {
        continue
      }

      for (const kindKey of kinds) {
        const kind = kindKey.replace(/\/$/, '')

        let names: string[]
        try {
          names = await this.client.list(joinPath(this.basePath, owner, kind))
        } catch {
          continue
        }

        const fetches = names.map(async (nameKey) => {
          const name = nameKey.replace(/\/$/, '')

          let data: Record<string, unknown> | null
          try {
            data = await this.client.get(joinPath(this.basePath, owner, kind, name))
          } catch {
            return
          }
          if (!data) return

          if (kind === SIMPLE_SECRET_KIND) {
            const entries = Object.entries(data)
            const allScalar =
              entries.length > 0 && entries.every(([, v]) => typeof v === 'string' || typeof v === 'number')
            if (allScalar) {
              const spec: Record<string, string> = {}
              for (const [k, v] of entries) {
                spec[k] = String(v)
              }
              facts.push({
                kind: SIMPLE_SECRET_KIND,
                metadata: { name },
                spec,
                owner,
              })
            }
          } else {
            if (data.kind && data.metadata && typeof (data.metadata as Record<string, unknown>).name === 'string') {
              facts.push(data as unknown as InfrastructureFact)
            }
          }
        })
        await Promise.all(fetches)
      }
    }

    return { facts }
  }

  async write(config: InfrastructureConfig): Promise<void> {
    if (!this.owner) {
      throw new Error('Owner is required for write operations')
    }

    for (const fact of config.facts) {
      validatePathSegment('Kind', fact.kind)
      validatePathSegment('Name', fact.metadata.name)
    }

    const ownerPath = joinPath(this.basePath, this.owner)
    const writtenPaths = new Set<string>()

    const writes = config.facts.map(async (fact) => {
      const path = factPath(this.basePath, this.owner!, fact.kind, fact.metadata.name)
      if (fact.kind === SIMPLE_SECRET_KIND) {
        await this.client.put(path, fact.spec as Record<string, string>)
      } else {
        await this.client.put(path, fact as unknown as Record<string, unknown>)
      }
      writtenPaths.add(path)
    })
    await Promise.all(writes)

    if (this.cleanupStale) {
      const kinds = await this.client.list(ownerPath)
      for (const kindKey of kinds) {
        const kind = kindKey.replace(/\/$/, '')
        const names = await this.client.list(joinPath(ownerPath, kind))
        const deletes = names.map(async (nameKey) => {
          const name = nameKey.replace(/\/$/, '')
          const path = joinPath(ownerPath, kind, name)
          if (!writtenPaths.has(path)) {
            await this.client.delete(path)
          }
        })
        await Promise.all(deletes)
      }
    }
  }
}
