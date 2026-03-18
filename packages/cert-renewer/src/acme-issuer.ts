/**
 * ACME certificate issuance via DNS-01 challenge.
 */
import { getToken, ARM_SCOPE } from './azure-auth.js'

export interface IssueCertRequest {
  domain: string
  dnsZone: string
  dnsZoneResourceGroup: string
  subscriptionId: string
  acmeEmail: string
  staging: boolean
}

export interface IssueCertResult {
  pfxBase64: string
  expiresAt: Date
}

function dnsRecordUrl(subscriptionId: string, rg: string, zone: string, recordName: string): string {
  return (
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/resourceGroups/${rg}` +
    `/providers/Microsoft.Network/dnsZones/${zone}` +
    `/TXT/${recordName}?api-version=2018-05-01`
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function issueCertificate(req: IssueCertRequest): Promise<IssueCertResult> {
  const acme = await import('acme-client')

  const directoryUrl = req.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production

  const accountKey = await acme.forge.createPrivateKey()
  const client = new acme.Client({ directoryUrl, accountKey })
  await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${req.acmeEmail}`] })

  const [certKey, certCsr] = await acme.forge.createCsr({ commonName: req.domain })

  const cert = await client.auto({
    csr: certCsr,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== 'dns-01') return

      const subdomain = req.domain.replace(`.${req.dnsZone}`, '')
      const recordName = `_acme-challenge${subdomain ? '.' + subdomain : ''}`

      const token = await getToken(ARM_SCOPE)
      const url = dnsRecordUrl(req.subscriptionId, req.dnsZoneResourceGroup, req.dnsZone, recordName)

      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: { TTL: 60, TXTRecords: [{ value: [keyAuthorization] }] },
        }),
      })

      if (!resp.ok) {
        throw new Error(`DNS TXT create failed (${resp.status}): ${await resp.text()}`)
      }

      await sleep(15_000)
    },
    challengeRemoveFn: async (_authz, challenge) => {
      if (challenge.type !== 'dns-01') return

      const subdomain = req.domain.replace(`.${req.dnsZone}`, '')
      const recordName = `_acme-challenge${subdomain ? '.' + subdomain : ''}`

      const token = await getToken(ARM_SCOPE)
      const url = dnsRecordUrl(req.subscriptionId, req.dnsZoneResourceGroup, req.dnsZone, recordName)

      await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    },
    challengePriority: ['dns-01'],
  })

  // Convert to PFX
  const forgeModule = await import('node-forge')
  const forge = forgeModule.default ?? forgeModule
  const certPem = cert.toString()
  const keyPem = certKey.toString()

  const forgeCert = forge.pki.certificateFromPem(certPem)
  const forgeKey = forge.pki.privateKeyFromPem(keyPem)

  const pemBlocks = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const chainCerts = pemBlocks.slice(1).map((pem) => forge.pki.certificateFromPem(pem))

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(forgeKey, [forgeCert, ...chainCerts], '', { algorithm: '3des' })
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes()
  const pfxBase64 = forge.util.encode64(p12Der)

  return {
    pfxBase64,
    expiresAt: forgeCert.validity.notAfter,
  }
}
