#!/usr/bin/env node
/**
 * CLI entry point — for Container App Job or local execution.
 *
 * Required env vars:
 *   AZURE_KEYVAULT_NAME    — Key Vault to scan
 *   AZURE_SUBSCRIPTION_ID  — Subscription for DNS zone access
 *   RENEW_BEFORE_DAYS      — Renew when < N days remaining (default: 30)
 */
import { renewCertificates } from './renew.js'

const vaultName = requiredEnv('AZURE_KEYVAULT_NAME')
const subscriptionId = requiredEnv('AZURE_SUBSCRIPTION_ID')
const renewBeforeDays = Number(process.env['RENEW_BEFORE_DAYS'] ?? '30')

renewCertificates({ vaultName, subscriptionId, renewBeforeDays })
  .then((result) => {
    if (result.failed > 0) process.exit(1)
  })
  .catch((err) => {
    console.error('[cert-renewer] Fatal error:', err)
    process.exit(1)
  })

function requiredEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}
