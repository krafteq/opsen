import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export interface AzureTestEnvironment {
  resourceGroupName: string
  environmentId: string
  location: string
}

/**
 * Create an Azure resource group and Container Apps environment for testing.
 * Uses `az` CLI directly (not Pulumi) so infrastructure exists before Pulumi runs.
 */
export function createAzureTestEnvironment(opts?: { testId?: string; location?: string }): AzureTestEnvironment {
  const testId = opts?.testId ?? randomBytes(4).toString('hex')
  const location = opts?.location ?? 'eastus'
  const rgName = `opsen-e2e-${testId}`
  const envName = `opsen-e2e-env-${testId}`

  console.log(`[azure-helpers] Creating resource group: ${rgName} in ${location}`)
  execSync(`az group create --name ${rgName} --location ${location} --output none`, {
    stdio: 'inherit',
    timeout: 60_000,
  })

  console.log(`[azure-helpers] Creating Container Apps environment: ${envName}`)
  execSync(
    `az containerapp env create --name ${envName} --resource-group ${rgName} --location ${location} --enable-workload-profiles false --output none`,
    {
      stdio: 'inherit',
      timeout: 300_000, // 5 min — ACA env creation can be slow
    },
  )

  // Get the environment ID
  const envIdOutput = execSync(
    `az containerapp env show --name ${envName} --resource-group ${rgName} --query id -o tsv`,
    {
      stdio: 'pipe',
      timeout: 30_000,
    },
  )
  const environmentId = envIdOutput.toString().trim()

  console.log(`[azure-helpers] Environment ready: ${environmentId}`)
  return { resourceGroupName: rgName, environmentId, location }
}

/**
 * Delete an Azure resource group (async, no-wait).
 * Best-effort cleanup — won't throw on failure.
 */
export function destroyAzureTestEnvironment(resourceGroupName: string): void {
  try {
    console.log(`[azure-helpers] Deleting resource group: ${resourceGroupName} (no-wait)`)
    execSync(`az group delete --name ${resourceGroupName} --yes --no-wait`, {
      stdio: 'inherit',
      timeout: 30_000,
    })
  } catch (err) {
    console.error(`[azure-helpers] Failed to delete resource group ${resourceGroupName}:`, err)
  }
}
