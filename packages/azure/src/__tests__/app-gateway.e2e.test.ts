/**
 * App Gateway E2E test.
 *
 * Tests dynamic-provider REST operations against a real App Gateway.
 * Uses `az account get-access-token` for auth (no SP credentials needed).
 *
 * Required environment variables:
 *   - AZURE_SUBSCRIPTION_ID
 *   - AZURE_RESOURCE_GROUP
 *   - AZURE_GATEWAY_NAME
 *   - AZURE_DNS_ZONE_NAME
 *   - AZURE_KEYVAULT_NAME
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { azureApiRequest } from '../app-gateway/azure-connection'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const subscriptionId = requireEnv('AZURE_SUBSCRIPTION_ID')
const resourceGroupName = requireEnv('AZURE_RESOURCE_GROUP')
const gatewayName = requireEnv('AZURE_GATEWAY_NAME')
const dnsZoneName = requireEnv('AZURE_DNS_ZONE_NAME')
const keyVaultName = requireEnv('AZURE_KEYVAULT_NAME')

const gwUrl =
  `https://management.azure.com/subscriptions/${subscriptionId}` +
  `/resourceGroups/${resourceGroupName}` +
  `/providers/Microsoft.Network/applicationGateways/${gatewayName}` +
  `?api-version=2024-01-01`

function getCliToken(resource: string): string {
  const result = execSync(`az account get-access-token --resource "${resource}" --query accessToken -o tsv`, {
    encoding: 'utf-8',
  })
  return result.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('App Gateway E2E', () => {
  let armToken: string

  beforeAll(async () => {
    // Verify gateway is provisioned
    armToken = getCliToken('https://management.azure.com')

    // Wait for gateway to be in Succeeded state
    for (let i = 0; i < 30; i++) {
      const { data } = await azureApiRequest('GET', gwUrl, armToken)
      const gw = data as any
      const state = gw?.properties?.provisioningState
      if (state === 'Succeeded') break
      if (state === 'Failed') throw new Error('App Gateway provisioning failed')
      console.log(`Waiting for App Gateway... (${state})`)
      await sleep(10_000)
    }
  }, 600_000)

  it('can read the gateway', async () => {
    const { status, data, etag } = await azureApiRequest('GET', gwUrl, armToken)
    const gw = data as any

    expect(status).toBe(200)
    expect(gw.name).toBe(gatewayName)
    expect(gw.properties.provisioningState).toBe('Succeeded')
    expect(etag).toBeDefined()
    expect(gw.properties.httpListeners.length).toBeGreaterThanOrEqual(1)
  })

  it('can add and remove a backend pool via read-modify-write', async () => {
    const poolName = `e2e-test-pool-${Date.now()}`

    // --- ADD ---
    const { data: gwBefore, etag } = await azureApiRequest('GET', gwUrl, armToken)
    const gw = gwBefore as any

    const pools: any[] = gw.properties.backendAddressPools ?? []
    pools.push({
      name: poolName,
      properties: {
        backendAddresses: [{ fqdn: 'test.example.com' }],
      },
    })
    gw.properties.backendAddressPools = pools

    const { status: putStatus } = await azureApiRequest('PUT', gwUrl, armToken, gw, etag)
    expect(putStatus).toBe(200)

    // Wait for provisioning
    await waitForGateway(armToken)

    // Verify pool was added
    const { data: gwAfterAdd } = await azureApiRequest('GET', gwUrl, armToken)
    const poolsAfterAdd = (gwAfterAdd as any).properties.backendAddressPools
    const added = poolsAfterAdd.find((p: any) => p.name === poolName)
    expect(added).toBeDefined()
    expect(added.properties.backendAddresses[0].fqdn).toBe('test.example.com')

    // --- REMOVE ---
    const { data: gwForRemove, etag: etag2 } = await azureApiRequest('GET', gwUrl, armToken)
    const gw2 = gwForRemove as any
    gw2.properties.backendAddressPools = gw2.properties.backendAddressPools.filter((p: any) => p.name !== poolName)

    const { status: removeStatus } = await azureApiRequest('PUT', gwUrl, armToken, gw2, etag2)
    expect(removeStatus).toBe(200)

    await waitForGateway(armToken)

    const { data: gwAfterRemove } = await azureApiRequest('GET', gwUrl, armToken)
    const poolsAfterRemove = (gwAfterRemove as any).properties.backendAddressPools
    const removed = poolsAfterRemove.find((p: any) => p.name === poolName)
    expect(removed).toBeUndefined()
  }, 600_000)

  it('can add a full listener + rule chain and remove it', async () => {
    const prefix = `e2e-${Date.now()}`
    const hostname = `e2e-test.${dnsZoneName}`

    // Get current gateway state
    const { data: gwData, etag } = await azureApiRequest('GET', gwUrl, armToken)
    const gw = gwData as any
    const gwId = gw.id as string

    // Add: backend pool, backend settings, probe, listener, routing rule
    gw.properties.backendAddressPools.push({
      name: `${prefix}-pool`,
      properties: { backendAddresses: [{ fqdn: 'nginx.example.com' }] },
    })

    gw.properties.probes = gw.properties.probes ?? []
    gw.properties.probes.push({
      name: `${prefix}-probe`,
      properties: {
        protocol: 'Http',
        host: 'nginx.example.com',
        path: '/health',
        interval: 30,
        timeout: 30,
        unhealthyThreshold: 3,
      },
    })

    gw.properties.backendHttpSettingsCollection.push({
      name: `${prefix}-settings`,
      properties: {
        port: 80,
        protocol: 'Http',
        requestTimeout: 30,
        probe: { id: `${gwId}/probes/${prefix}-probe` },
      },
    })

    gw.properties.httpListeners.push({
      name: `${prefix}-listener`,
      properties: {
        hostName: hostname,
        protocol: 'Http',
        frontendIPConfiguration: { id: `${gwId}/frontendIPConfigurations/appGatewayFrontendIP` },
        frontendPort: { id: `${gwId}/frontendPorts/appGatewayFrontendPort` },
      },
    })

    gw.properties.requestRoutingRules.push({
      name: `${prefix}-rule`,
      properties: {
        ruleType: 'Basic',
        priority: 100,
        httpListener: { id: `${gwId}/httpListeners/${prefix}-listener` },
        backendAddressPool: { id: `${gwId}/backendAddressPools/${prefix}-pool` },
        backendHttpSettings: { id: `${gwId}/backendHttpSettingsCollection/${prefix}-settings` },
      },
    })

    const { status } = await azureApiRequest('PUT', gwUrl, armToken, gw, etag)
    expect(status).toBe(200)

    await waitForGateway(armToken)

    // Verify everything exists
    const { data: verifyData } = await azureApiRequest('GET', gwUrl, armToken)
    const verify = verifyData as any

    expect(verify.properties.backendAddressPools.find((p: any) => p.name === `${prefix}-pool`)).toBeDefined()
    expect(verify.properties.probes.find((p: any) => p.name === `${prefix}-probe`)).toBeDefined()
    expect(
      verify.properties.backendHttpSettingsCollection.find((s: any) => s.name === `${prefix}-settings`),
    ).toBeDefined()
    expect(verify.properties.httpListeners.find((l: any) => l.name === `${prefix}-listener`)).toBeDefined()
    expect(verify.properties.requestRoutingRules.find((r: any) => r.name === `${prefix}-rule`)).toBeDefined()

    // Remove everything (order matters: rule first, then listener, then rest)
    const { data: cleanData, etag: cleanEtag } = await azureApiRequest('GET', gwUrl, armToken)
    const clean = cleanData as any

    clean.properties.requestRoutingRules = clean.properties.requestRoutingRules.filter(
      (r: any) => r.name !== `${prefix}-rule`,
    )
    clean.properties.httpListeners = clean.properties.httpListeners.filter((l: any) => l.name !== `${prefix}-listener`)
    clean.properties.backendHttpSettingsCollection = clean.properties.backendHttpSettingsCollection.filter(
      (s: any) => s.name !== `${prefix}-settings`,
    )
    clean.properties.probes = clean.properties.probes.filter((p: any) => p.name !== `${prefix}-probe`)
    clean.properties.backendAddressPools = clean.properties.backendAddressPools.filter(
      (p: any) => p.name !== `${prefix}-pool`,
    )

    const { status: cleanStatus } = await azureApiRequest('PUT', gwUrl, armToken, clean, cleanEtag)
    expect(cleanStatus).toBe(200)

    await waitForGateway(armToken)
  }, 600_000)

  it('can create and delete a DNS TXT record via Azure DNS REST API', async () => {
    const recordName = `_acme-challenge.e2e-test-${Date.now()}`
    const dnsUrl =
      `https://management.azure.com/subscriptions/${subscriptionId}` +
      `/resourceGroups/${resourceGroupName}` +
      `/providers/Microsoft.Network/dnsZones/${dnsZoneName}` +
      `/TXT/${recordName}?api-version=2018-05-01`

    // Create TXT record
    const { status: createStatus } = await azureApiRequest('PUT', dnsUrl, armToken, {
      properties: {
        TTL: 60,
        TXTRecords: [{ value: ['test-acme-challenge-value'] }],
      },
    })
    expect([200, 201]).toContain(createStatus)

    // Verify it exists
    const { status: readStatus, data } = await azureApiRequest('GET', dnsUrl, armToken)
    expect(readStatus).toBe(200)
    expect((data as any).properties.TXTRecords[0].value[0]).toBe('test-acme-challenge-value')

    // Delete
    const { status: deleteStatus } = await azureApiRequest('DELETE', dnsUrl, armToken)
    expect(deleteStatus).toBe(200)

    // Verify deleted
    const { status: verifyStatus } = await azureApiRequest('GET', dnsUrl, armToken)
    expect(verifyStatus).toBe(404)
  }, 60_000)

  it('can write and read a Key Vault secret', async () => {
    const kvToken = getCliToken('https://vault.azure.net')
    const secretName = `e2e-appgw-test-${Date.now()}`
    const kvUrl = `https://${keyVaultName}.vault.azure.net/secrets/${secretName}?api-version=7.4`

    // Write secret
    const { status: writeStatus } = await azureApiRequest('PUT', kvUrl, kvToken, {
      value: 'dGVzdC1wZngtY29udGVudA==',
      contentType: 'application/x-pkcs12',
      attributes: { enabled: true },
    })
    expect(writeStatus).toBe(200)

    // Read secret
    const { status: readStatus, data } = await azureApiRequest('GET', kvUrl, kvToken)
    expect(readStatus).toBe(200)
    expect((data as any).value).toBe('dGVzdC1wZngtY29udGVudA==')
    expect((data as any).contentType).toBe('application/x-pkcs12')

    // Delete secret
    const deleteUrl = `https://${keyVaultName}.vault.azure.net/secrets/${secretName}?api-version=7.4`
    await azureApiRequest('DELETE', deleteUrl, kvToken)
  }, 60_000)
})

async function waitForGateway(token: string, maxWaitMs = 300_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const { data } = await azureApiRequest('GET', gwUrl, token)
    const state = (data as any)?.properties?.provisioningState
    if (state === 'Succeeded') return
    if (state === 'Failed') throw new Error('App Gateway provisioning failed')
    await sleep(10_000)
  }
  throw new Error('Timeout waiting for App Gateway')
}
