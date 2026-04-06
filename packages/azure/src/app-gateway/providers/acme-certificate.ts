import * as pulumi from '@pulumi/pulumi'

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

const KV_SCOPE = 'https://vault.azure.net/.default'

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

export interface AcmeCertificateInputs {
  connection: pulumi.Input<AzureConnection>
  domain: pulumi.Input<string>
  dnsZoneResourceGroup: pulumi.Input<string>
  dnsZoneName: pulumi.Input<string>
  keyVaultName: pulumi.Input<string>
  acmeEmail: pulumi.Input<string>
  /** Use Let's Encrypt staging directory (default false) */
  staging?: pulumi.Input<boolean>
}

interface AcmeCertificateProviderInputs {
  connection: AzureConnection
  domain: string
  dnsZoneResourceGroup: string
  dnsZoneName: string
  keyVaultName: string
  acmeEmail: string
  staging: boolean
}

interface AcmeCertificateOutputs extends AcmeCertificateProviderInputs {
  keyVaultSecretId: string
}

function secretName(domain: string): string {
  return `appgw-cert-${domain.replace(/\./g, '-')}`
}

function kvSecretUrl(vaultName: string, name: string): string {
  return `https://${vaultName}.vault.azure.net/secrets/${name}?api-version=7.4`
}

function kvDeletedSecretUrl(vaultName: string, name: string): string {
  return `https://${vaultName}.vault.azure.net/deletedsecrets/${name}?api-version=7.4`
}

/**
 * Recover a soft-deleted secret and wait for it to become available.
 * Key Vault soft-delete means secrets aren't immediately purged on DELETE —
 * they must be recovered before they can be overwritten with PUT.
 */
async function recoverSoftDeletedSecret(vaultName: string, name: string, token: string): Promise<void> {
  const recoverUrl = `https://${vaultName}.vault.azure.net/deletedsecrets/${name}/recover?api-version=7.4`
  await azureApiRequest('POST', recoverUrl, token)
  // Poll until the secret is available again (recovery can take a few seconds)
  const url = kvSecretUrl(vaultName, name)
  for (let i = 0; i < 30; i++) {
    const { status } = await azureApiRequest('GET', url, token).catch(() => ({ status: 404 }))
    if (status !== 404) return
    await new Promise((r) => setTimeout(r, 1000))
  }
}

function isConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('409') ||
      err.message.includes('Conflict') ||
      err.message.includes('ObjectIsDeletedButRecoverable'))
  )
}

/**
 * Creates a tagged Key Vault secret placeholder for the cert-renewer job to discover.
 * The job handles actual ACME issuance and renewal.
 *
 * Tags written:
 *   opsen-managed: "true"
 *   domain, dns-zone, dns-zone-rg, acme-email, acme-staging
 */
const acmeCertificateProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: AcmeCertificateProviderInputs) {
    const kvToken = await getAzureToken(inputs.connection, KV_SCOPE)
    const name = secretName(inputs.domain)
    const url = kvSecretUrl(inputs.keyVaultName, name)

    const tags = {
      'opsen-managed': 'true',
      domain: inputs.domain,
      'dns-zone': inputs.dnsZoneName,
      'dns-zone-rg': inputs.dnsZoneResourceGroup,
      'acme-email': inputs.acmeEmail,
      'acme-staging': String(inputs.staging),
    }

    // Create placeholder secret — cert-renewer job will fill with real PFX.
    // If the secret was soft-deleted (e.g. after a destroy + re-apply), recover it first.
    try {
      await azureApiRequest('PUT', url, kvToken, {
        value: 'pending',
        contentType: 'application/x-pkcs12',
        tags,
        attributes: { enabled: true },
      })
    } catch (err) {
      if (isConflict(err)) {
        await recoverSoftDeletedSecret(inputs.keyVaultName, name, kvToken)
        await azureApiRequest('PUT', url, kvToken, {
          value: 'pending',
          contentType: 'application/x-pkcs12',
          tags,
          attributes: { enabled: true },
        })
      } else {
        throw err
      }
    }

    const keyVaultSecretId = `https://${inputs.keyVaultName}.vault.azure.net/secrets/${name}`
    const outs: AcmeCertificateOutputs = { ...inputs, keyVaultSecretId }
    return { id: name, outs }
  },

  async read(id: string, props: AcmeCertificateOutputs) {
    const kvToken = await getAzureToken(props.connection, KV_SCOPE)
    const url = kvSecretUrl(props.keyVaultName, id)
    const { status } = await azureApiRequest('GET', url, kvToken)

    if (status === 404) {
      throw new Error(`Key Vault secret ${id} not found`)
    }

    return { id, props }
  },

  async update(_id: string, _olds: AcmeCertificateOutputs, news: AcmeCertificateProviderInputs) {
    const kvToken = await getAzureToken(news.connection, KV_SCOPE)
    const name = secretName(news.domain)
    const url = kvSecretUrl(news.keyVaultName, name)

    const tags = {
      'opsen-managed': 'true',
      domain: news.domain,
      'dns-zone': news.dnsZoneName,
      'dns-zone-rg': news.dnsZoneResourceGroup,
      'acme-email': news.acmeEmail,
      'acme-staging': String(news.staging),
    }

    // Update tags — cert-renewer will pick up new config on next run
    await azureApiRequest('PATCH', `${url.replace('?', '/versions?')}`, kvToken).catch(() => {})

    // Re-create with updated tags
    await azureApiRequest('PUT', url, kvToken, {
      value: 'pending',
      contentType: 'application/x-pkcs12',
      tags,
      attributes: { enabled: true },
    })

    const keyVaultSecretId = `https://${news.keyVaultName}.vault.azure.net/secrets/${name}`
    const outs: AcmeCertificateOutputs = { ...news, keyVaultSecretId }
    return { outs }
  },

  async delete(id: string, props: AcmeCertificateOutputs) {
    const kvToken = await getAzureToken(props.connection, KV_SCOPE)
    const url = kvSecretUrl(props.keyVaultName, id)
    await azureApiRequest('DELETE', url, kvToken)
    // Purge the soft-deleted secret so re-creates don't hit 409 Conflict
    const purgeUrl = kvDeletedSecretUrl(props.keyVaultName, id)
    // Wait briefly for the delete to propagate before purging
    await new Promise((r) => setTimeout(r, 2000))
    await azureApiRequest('DELETE', purgeUrl, kvToken).catch(() => {})
  },

  async diff(_id: string, olds: AcmeCertificateOutputs, news: AcmeCertificateProviderInputs) {
    const replaces: string[] = []
    if (olds.domain !== news.domain) replaces.push('domain')
    if (olds.keyVaultName !== news.keyVaultName) replaces.push('keyVaultName')

    const changes = replaces.length > 0 || olds.acmeEmail !== news.acmeEmail || olds.staging !== news.staging

    return { changes, replaces }
  },
}

export class AcmeCertificate extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly domain: pulumi.Output<string>
  declare public readonly keyVaultSecretId: pulumi.Output<string>
  declare public readonly dnsZoneResourceGroup: pulumi.Output<string>
  declare public readonly dnsZoneName: pulumi.Output<string>
  declare public readonly keyVaultName: pulumi.Output<string>
  declare public readonly acmeEmail: pulumi.Output<string>
  declare public readonly staging: pulumi.Output<boolean>

  constructor(name: string, args: AcmeCertificateInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      acmeCertificateProvider,
      name,
      {
        connection: pulumi.secret(args.connection),
        domain: args.domain,
        dnsZoneResourceGroup: args.dnsZoneResourceGroup,
        dnsZoneName: args.dnsZoneName,
        keyVaultName: args.keyVaultName,
        acmeEmail: args.acmeEmail,
        staging: args.staging ?? false,
        keyVaultSecretId: undefined,
      },
      opts,
    )
  }
}
