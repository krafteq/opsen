/**
 * Core renewal logic — shared between CLI (Container App Job) and Azure Function entry points.
 */
import { discoverCertSecrets, updateCertSecret } from './keyvault.js'
import { issueCertificate } from './acme-issuer.js'

export interface RenewOptions {
  vaultName: string
  subscriptionId: string
  renewBeforeDays?: number
}

export interface RenewResult {
  renewed: number
  skipped: number
  failed: number
}

export async function renewCertificates(opts: RenewOptions): Promise<RenewResult> {
  const renewBeforeDays = opts.renewBeforeDays ?? 30

  console.log(`[cert-renewer] Scanning vault "${opts.vaultName}" for opsen-managed certificates...`)

  const secrets = await discoverCertSecrets(opts.vaultName)
  console.log(`[cert-renewer] Found ${secrets.length} managed certificate(s)`)

  let renewed = 0
  let skipped = 0
  let failed = 0

  for (const secret of secrets) {
    const label = `${secret.name} (${secret.domain})`

    if (!secret.domain || !secret.dnsZone || !secret.dnsZoneResourceGroup || !secret.acmeEmail) {
      console.log(`[cert-renewer] SKIP ${label} — missing required tags`)
      skipped++
      continue
    }

    const daysRemaining = secret.expiresOn ? Math.floor((secret.expiresOn.getTime() - Date.now()) / 86_400_000) : -1

    if (daysRemaining > renewBeforeDays) {
      console.log(`[cert-renewer] SKIP ${label} — ${daysRemaining} days remaining`)
      skipped++
      continue
    }

    console.log(
      `[cert-renewer] RENEW ${label} — ${daysRemaining >= 0 ? `${daysRemaining} days remaining` : 'no certificate yet'}`,
    )

    try {
      const result = await issueCertificate({
        domain: secret.domain,
        dnsZone: secret.dnsZone,
        dnsZoneResourceGroup: secret.dnsZoneResourceGroup,
        subscriptionId: opts.subscriptionId,
        acmeEmail: secret.acmeEmail,
        staging: secret.staging,
      })

      await updateCertSecret(
        opts.vaultName,
        secret.name,
        result.pfxBase64,
        {
          'opsen-managed': 'true',
          domain: secret.domain,
          'dns-zone': secret.dnsZone,
          'dns-zone-rg': secret.dnsZoneResourceGroup,
          'acme-email': secret.acmeEmail,
          'acme-staging': String(secret.staging),
        },
        result.expiresAt,
      )

      console.log(`[cert-renewer] OK ${label} — renewed, expires ${result.expiresAt.toISOString()}`)
      renewed++
    } catch (err) {
      console.error(`[cert-renewer] FAIL ${label}:`, err)
      failed++
    }
  }

  console.log(`[cert-renewer] Done: ${renewed} renewed, ${skipped} skipped, ${failed} failed`)

  return { renewed, skipped, failed }
}
