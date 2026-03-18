/**
 * Azure token acquisition for Container App Jobs using Managed Identity.
 * Falls back to Azure CLI for local development.
 */

interface TokenCacheEntry {
  token: string
  expiresAt: number
}

const cache = new Map<string, TokenCacheEntry>()

export async function getToken(scope: string): Promise<string> {
  const cached = cache.get(scope)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token
  }

  // Try Managed Identity endpoint (Container App Job / Azure VM)
  const msiEndpoint = process.env.IDENTITY_ENDPOINT
  const msiHeader = process.env.IDENTITY_HEADER
  if (msiEndpoint && msiHeader) {
    const url = `${msiEndpoint}?api-version=2019-08-01&resource=${encodeURIComponent(scope.replace('/.default', ''))}`
    const resp = await fetch(url, { headers: { 'X-IDENTITY-HEADER': msiHeader } })
    if (resp.ok) {
      const data = (await resp.json()) as { access_token: string; expires_on: string }
      const token = data.access_token
      cache.set(scope, { token, expiresAt: Number(data.expires_on) * 1000 })
      return token
    }
  }

  // Fallback: Azure CLI (local dev)
  const { execSync } = await import('node:child_process')
  try {
    const resource = scope.replace('/.default', '')
    const result = execSync(`az account get-access-token --resource "${resource}" --query accessToken -o tsv`, {
      encoding: 'utf-8',
    })
    const token = result.trim()
    cache.set(scope, { token, expiresAt: Date.now() + 3600_000 })
    return token
  } catch {
    throw new Error(`Failed to acquire token for scope ${scope}. Ensure managed identity or Azure CLI is configured.`)
  }
}

export const ARM_SCOPE = 'https://management.azure.com/.default'
export const KV_SCOPE = 'https://vault.azure.net/.default'
