import * as pulumi from '@pulumi/pulumi'

export interface AzureConnection {
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

/**
 * Acquire an OAuth2 token for the given scope, caching by tenant+client+scope.
 */
export async function getAzureToken(conn: AzureConnection, scope: string): Promise<string> {
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

/**
 * Generic Azure REST API request. Returns parsed JSON. 404 returns `{ status: 404, data: null }`.
 */
export async function azureApiRequest(
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

/** Extract connection-related fields from inputs for use in dynamic provider constructors. */
export function connectionInputs(conn: pulumi.Input<AzureConnection>): Record<string, pulumi.Input<unknown>> {
  return { connection: conn }
}

/** Azure ARM scope for management API calls. */
export const ARM_SCOPE = 'https://management.azure.com/.default'

/** Azure Key Vault scope for secret/certificate API calls. */
export const KV_SCOPE = 'https://vault.azure.net/.default'
