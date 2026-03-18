/**
 * Key Vault operations: discover certs, read metadata, update secrets.
 */
import { getToken, KV_SCOPE } from './azure-auth.js'

export interface CertSecret {
  name: string
  domain: string
  dnsZone: string
  dnsZoneResourceGroup: string
  acmeEmail: string
  staging: boolean
  expiresOn?: Date
}

/**
 * Discover all opsen-managed certificate secrets in a Key Vault.
 */
export async function discoverCertSecrets(vaultName: string): Promise<CertSecret[]> {
  const token = await getToken(KV_SCOPE)
  const baseUrl = `https://${vaultName}.vault.azure.net`

  // List all secrets
  const secrets: CertSecret[] = []
  let nextLink: string | undefined = `${baseUrl}/secrets?api-version=7.4`

  while (nextLink) {
    const resp = await fetch(nextLink, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!resp.ok) {
      throw new Error(`KV list secrets failed (${resp.status}): ${await resp.text()}`)
    }

    const data = (await resp.json()) as {
      value: Array<{
        id: string
        attributes: { exp?: number; enabled: boolean }
        tags?: Record<string, string>
      }>
      nextLink?: string
    }

    for (const item of data.value) {
      const tags = item.tags ?? {}
      if (tags['opsen-managed'] !== 'true') continue

      const name = item.id.split('/').pop()!
      secrets.push({
        name,
        domain: tags['domain'] ?? '',
        dnsZone: tags['dns-zone'] ?? '',
        dnsZoneResourceGroup: tags['dns-zone-rg'] ?? '',
        acmeEmail: tags['acme-email'] ?? '',
        staging: tags['acme-staging'] === 'true',
        expiresOn: item.attributes.exp ? new Date(item.attributes.exp * 1000) : undefined,
      })
    }

    nextLink = data.nextLink
  }

  return secrets
}

/**
 * Store a PFX certificate in Key Vault, preserving discovery tags.
 */
export async function updateCertSecret(
  vaultName: string,
  name: string,
  pfxBase64: string,
  tags: Record<string, string>,
  expiresOn: Date,
): Promise<void> {
  const token = await getToken(KV_SCOPE)
  const url = `https://${vaultName}.vault.azure.net/secrets/${name}?api-version=7.4`

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      value: pfxBase64,
      contentType: 'application/x-pkcs12',
      tags,
      attributes: {
        enabled: true,
        exp: Math.floor(expiresOn.getTime() / 1000),
      },
    }),
  })

  if (!resp.ok) {
    throw new Error(`KV set secret ${name} failed (${resp.status}): ${await resp.text()}`)
  }
}
