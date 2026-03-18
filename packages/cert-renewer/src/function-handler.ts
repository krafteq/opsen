/**
 * Azure Function v3 handler — timer trigger.
 *
 * This is the entry point bundled into the Azure Function zip artifact.
 * Uses v3 model (function.json) with CJS output for Azure Functions compatibility.
 *
 * Expects app settings:
 *   AZURE_KEYVAULT_NAME, AZURE_SUBSCRIPTION_ID, RENEW_BEFORE_DAYS
 */
import { renewCertificates } from './renew.js'

interface FunctionContext {
  log: (...args: unknown[]) => void
}

export default async function certRenewalTimer(context: FunctionContext): Promise<void> {
  const vaultName = process.env['AZURE_KEYVAULT_NAME']
  const subscriptionId = process.env['AZURE_SUBSCRIPTION_ID']
  const renewBeforeDays = Number(process.env['RENEW_BEFORE_DAYS'] ?? '30')

  if (!vaultName || !subscriptionId) {
    context.log('Missing AZURE_KEYVAULT_NAME or AZURE_SUBSCRIPTION_ID')
    throw new Error('Missing required app settings')
  }

  const result = await renewCertificates({ vaultName, subscriptionId, renewBeforeDays })

  context.log(`Cert renewal complete: ${result.renewed} renewed, ${result.skipped} skipped, ${result.failed} failed`)

  if (result.failed > 0) {
    throw new Error(`${result.failed} certificate(s) failed to renew`)
  }
}
