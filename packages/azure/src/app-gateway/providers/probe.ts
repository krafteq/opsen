import * as pulumi from '@pulumi/pulumi'

// ── Inlined azure-connection (dynamic providers must be self-contained) ──

interface AzureConnection {
  subscriptionId: string
  resourceGroupName: string
  tenantId: string
  clientId: string
  clientSecret: string
}

interface TokenCacheEntry {
  token: string
  expiresAt: number
}

const tokenCache: Record<string, TokenCacheEntry> = {}

const ARM_SCOPE = 'https://management.azure.com/.default'

async function getAzureToken(conn: AzureConnection, scope: string): Promise<string> {
  const cacheKey = `${conn.tenantId}:${conn.clientId}:${scope}`
  const cached = tokenCache[cacheKey]
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token
  }

  const url = `https://login.microsoftonline.com/${conn.tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: conn.clientId,
    client_secret: conn.clientSecret,
    scope,
  })

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Azure token request failed (${resp.status}): ${text}`)
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number }
  tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

async function azureApiRequest(
  method: string,
  url: string,
  token: string,
  body?: unknown,
  etag?: string,
): Promise<{ status: number; data: unknown; etag?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  if (etag) {
    headers['If-Match'] = etag
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await resp.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }

  if (resp.status === 404) {
    return { status: 404, data: null }
  }

  if (!resp.ok) {
    throw new Error(
      `Azure API ${method} ${url} returned ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    )
  }

  return { status: resp.status, data, etag: resp.headers.get('etag') ?? undefined }
}

// ── Inlined sub-resource provider factory ──

interface SubResourceProviderInputs {
  connection: AzureConnection
  gatewayName: string
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

// ── Probe provider ──

export interface AppGatewayProbeInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  protocol: pulumi.Input<'Http' | 'Https'>
  host?: pulumi.Input<string>
  path: pulumi.Input<string>
  interval?: pulumi.Input<number>
  timeout?: pulumi.Input<number>
  unhealthyThreshold?: pulumi.Input<number>
  /** Pick host from backend HTTP settings (default true) */
  pickHostNameFromBackendHttpSettings?: pulumi.Input<boolean>
}

const ARRAY_PROPERTY = 'probes'
const DISPLAY_NAME = 'Health Probe'

const provider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: SubResourceProviderInputs) {
    const { connection, gatewayName, entry } = inputs
    const entryName = entry.name as string

    await modifyGateway(connection, gatewayName, ARRAY_PROPERTY, (arr) => {
      const idx = arr.findIndex((e: Record<string, unknown>) => e.name === entryName)
      if (idx >= 0) {
        arr[idx] = entry
      } else {
        arr.push(entry)
      }
      return arr
    })

    return { id: `${gatewayName}/${ARRAY_PROPERTY}/${entryName}`, outs: inputs }
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
    const arr: Record<string, unknown>[] = gw.properties?.[ARRAY_PROPERTY] ?? []
    const found = arr.find((e) => e.name === entryName)

    if (!found) {
      throw new Error(`${DISPLAY_NAME} '${entryName}' not found on gateway ${gatewayName}`)
    }

    return { id, props }
  },

  async update(_id: string, _olds: SubResourceProviderInputs, news: SubResourceProviderInputs) {
    const { connection, gatewayName, entry } = news
    const entryName = entry.name as string

    await modifyGateway(connection, gatewayName, ARRAY_PROPERTY, (arr) => {
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

    await modifyGateway(connection, gatewayName, ARRAY_PROPERTY, (arr) => {
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

export class AppGatewayProbe extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>

  constructor(name: string, args: AppGatewayProbeInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => {
      const props: Record<string, unknown> = {
        protocol: a.protocol,
        path: a.path,
        interval: a.interval ?? 30,
        timeout: a.timeout ?? 30,
        unhealthyThreshold: a.unhealthyThreshold ?? 3,
        pickHostNameFromBackendHttpSettings: a.pickHostNameFromBackendHttpSettings ?? true,
      }
      if (a.host) {
        props.host = a.host
      }
      return { name: a.name, properties: props }
    })

    super(
      provider,
      name,
      {
        connection: pulumi.secret(args.connection),
        gatewayName: args.gatewayName,
        entry,
      },
      { ...opts, customTimeouts: { create: '10m', update: '10m', delete: '10m' } },
    )
  }
}
