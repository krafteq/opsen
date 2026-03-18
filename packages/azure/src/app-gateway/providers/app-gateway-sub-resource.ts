import * as pulumi from '@pulumi/pulumi'
import { AzureConnection, getAzureToken, azureApiRequest, ARM_SCOPE } from '../azure-connection'

export interface SubResourceConfig {
  /** JSON property name on the App Gateway (e.g. 'httpListeners') */
  arrayProperty: string
  /** Human-readable name for error messages */
  displayName: string
}

export interface SubResourceProviderInputs {
  connection: AzureConnection
  gatewayName: string
  /** The sub-resource entry to add/update — must have a `name` field */
  entry: Record<string, unknown>
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

function gatewayUrl(conn: AzureConnection, gatewayName: string): string {
  return (
    `https://management.azure.com/subscriptions/${conn.subscriptionId}` +
    `/resourceGroups/${conn.resourceGroupName}` +
    `/providers/Microsoft.Network/applicationGateways/${gatewayName}` +
    `?api-version=2024-01-01`
  )
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Factory that creates a dynamic ResourceProvider for an App Gateway inline sub-resource array.
 * Uses optimistic concurrency (etag) with retry on 412.
 */
export function createSubResourceProvider(config: SubResourceConfig): pulumi.dynamic.ResourceProvider {
  return {
    async create(inputs: SubResourceProviderInputs) {
      const { connection, gatewayName, entry } = inputs
      const entryName = entry.name as string

      await modifyGateway(connection, gatewayName, config.arrayProperty, (arr) => {
        const idx = arr.findIndex((e: Record<string, unknown>) => e.name === entryName)
        if (idx >= 0) {
          arr[idx] = entry
        } else {
          arr.push(entry)
        }
        return arr
      })

      return { id: `${gatewayName}/${config.arrayProperty}/${entryName}`, outs: inputs }
    },

    async read(id: string, props: SubResourceProviderInputs) {
      const { connection, gatewayName, entry } = props
      const entryName = entry.name as string
      const token = await getAzureToken(connection, ARM_SCOPE)
      const url = gatewayUrl(connection, gatewayName)
      const { status, data } = await azureApiRequest('GET', url, token)

      if (status === 404) {
        throw new Error(`App Gateway ${gatewayName} not found`)
      }

      const gw = data as Record<string, any>
      const arr: Record<string, unknown>[] = gw.properties?.[config.arrayProperty] ?? []
      const found = arr.find((e) => e.name === entryName)

      if (!found) {
        throw new Error(`${config.displayName} '${entryName}' not found on gateway ${gatewayName}`)
      }

      return { id, props }
    },

    async update(_id: string, _olds: SubResourceProviderInputs, news: SubResourceProviderInputs) {
      const { connection, gatewayName, entry } = news
      const entryName = entry.name as string

      await modifyGateway(connection, gatewayName, config.arrayProperty, (arr) => {
        const idx = arr.findIndex((e: Record<string, unknown>) => e.name === entryName)
        if (idx >= 0) {
          arr[idx] = entry
        } else {
          arr.push(entry)
        }
        return arr
      })

      return { outs: news }
    },

    async delete(_id: string, props: SubResourceProviderInputs) {
      const { connection, gatewayName, entry } = props
      const entryName = entry.name as string

      await modifyGateway(connection, gatewayName, config.arrayProperty, (arr) => {
        return arr.filter((e: Record<string, unknown>) => e.name !== entryName)
      })
    },

    async diff(_id: string, olds: SubResourceProviderInputs, news: SubResourceProviderInputs) {
      const replaces: string[] = []
      if (olds.gatewayName !== news.gatewayName) replaces.push('gatewayName')
      if ((olds.entry.name as string) !== (news.entry.name as string)) replaces.push('entry.name')

      const changes = replaces.length > 0 || JSON.stringify(olds.entry) !== JSON.stringify(news.entry)

      return { changes, replaces }
    },
  }
}

/**
 * Perform an atomic read-modify-write on an App Gateway sub-resource array.
 * Retries on 412 (etag mismatch) up to MAX_RETRIES times.
 */
async function modifyGateway(
  connection: AzureConnection,
  gatewayName: string,
  arrayProperty: string,
  modify: (arr: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  const url = gatewayUrl(connection, gatewayName)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getAzureToken(connection, ARM_SCOPE)
    const { data, etag } = await azureApiRequest('GET', url, token)
    const gw = data as Record<string, any>

    if (!gw.properties) {
      gw.properties = {}
    }
    const arr: Record<string, unknown>[] = gw.properties[arrayProperty] ?? []
    gw.properties[arrayProperty] = modify(arr)

    try {
      await azureApiRequest('PUT', url, token, gw, etag)
      return
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('412') && attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1))
        continue
      }
      throw err
    }
  }
}
