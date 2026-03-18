import * as fs from 'node:fs'
import * as pulumi from '@pulumi/pulumi'
import * as authorization from '@pulumi/azure-native/authorization'
import * as storage from '@pulumi/azure-native/storage'
import * as web from '@pulumi/azure-native/web'

export interface CertRenewalFunctionArgs {
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Azure subscription ID */
  subscriptionId: pulumi.Input<string>
  /** Key Vault name to scan for certs */
  keyVaultName: pulumi.Input<string>
  /** Key Vault resource ID (for RBAC assignment) */
  keyVaultId: pulumi.Input<string>
  /** Cron expression (default: "0 0 3 * * *" = daily at 3am UTC) — NCRONTAB 6-field format */
  schedule?: pulumi.Input<string>
  /** Renew when certificate has fewer than N days remaining (default: 30) */
  renewBeforeDays?: number
  /** DNS zone resource IDs to grant contributor access */
  dnsZoneIds?: pulumi.Input<pulumi.Input<string>[]>
  /**
   * Path to the Azure Function zip artifact.
   * Defaults to the pre-built zip from @opsen/cert-renewer package.
   */
  functionZipPath?: string
  /** Storage account for Function App (created if not provided) */
  storageAccount?: {
    name: pulumi.Input<string>
    connectionString: pulumi.Input<string>
  }
}

export interface CertRenewalFunctionRef {
  functionApp: web.WebApp
  identityPrincipalId: pulumi.Output<string>
}

// Key Vault Secrets Officer
const KV_SECRETS_OFFICER_ROLE = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
// DNS Zone Contributor
const DNS_ZONE_CONTRIBUTOR_ROLE = 'befefa01-2a29-4197-83a8-272ff33ce314'

/**
 * Resolve the pre-built Azure Function zip from @opsen/cert-renewer.
 * Falls back to require.resolve for monorepo/file: dependency scenarios.
 */
function resolveDefaultFunctionZip(): string {
  try {
    // In published packages: @opsen/cert-renewer/dist/azure-function.zip
    return require.resolve('@opsen/cert-renewer/azure-function.zip')
  } catch {
    // Monorepo with file: deps — resolve from the package root
    const pkgPath = require.resolve('@opsen/cert-renewer')
    const pkgDir = pkgPath.substring(0, pkgPath.lastIndexOf('/dist/'))
    return `${pkgDir}/dist/azure-function.zip`
  }
}

/**
 * Deploy an Azure Function App (Consumption plan, Node.js 22) that periodically
 * renews ACME certificates discovered in Key Vault.
 *
 * The function code is deployed from the pre-built zip in @opsen/cert-renewer.
 * All dependencies are bundled into a single file via esbuild (282KB zip).
 *
 * Assigns RBAC via system-assigned managed identity:
 *   - Key Vault Secrets Officer on the vault
 *   - DNS Zone Contributor on each DNS zone
 */
export function createCertRenewalFunction(name: string, args: CertRenewalFunctionArgs): CertRenewalFunctionRef {
  const zipPath = args.functionZipPath ?? resolveDefaultFunctionZip()

  // Read zip file as base64 for blob upload
  const zipContent = fs.readFileSync(zipPath)
  const zipBase64 = zipContent.toString('base64')

  // Storage account for Function App runtime + zip hosting
  let storageAccountName: pulumi.Input<string>
  let storageConnectionString: pulumi.Input<string>

  if (args.storageAccount) {
    storageAccountName = args.storageAccount.name
    storageConnectionString = args.storageAccount.connectionString
  } else {
    const saName = name.replace(/[^a-z0-9]/g, '').substring(0, 24)
    const sa = new storage.StorageAccount(`${name}-sa`, {
      accountName: saName,
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      kind: storage.Kind.StorageV2,
      sku: { name: storage.SkuName.Standard_LRS },
    })

    storageAccountName = sa.name

    storageConnectionString = pulumi
      .all([sa.name, args.resourceGroupName])
      .apply(([accountName, rg]) => storage.listStorageAccountKeys({ accountName, resourceGroupName: rg }))
      .apply(
        (keys) =>
          `DefaultEndpointsProtocol=https;AccountName=${saName};AccountKey=${keys.keys[0].value};EndpointSuffix=core.windows.net`,
      )
  }

  // Blob container + zip upload
  const container = new storage.BlobContainer(`${name}-releases`, {
    accountName: storageAccountName,
    resourceGroupName: args.resourceGroupName,
    containerName: 'function-releases',
    publicAccess: storage.PublicAccess.None,
  })

  const blob = new storage.Blob(`${name}-zip`, {
    accountName: storageAccountName,
    resourceGroupName: args.resourceGroupName,
    containerName: container.name,
    blobName: `cert-renewer-${Date.now()}.zip`,
    source: new pulumi.asset.StringAsset(zipBase64),
    contentType: 'application/zip',
  })

  // Generate SAS URL for WEBSITE_RUN_FROM_PACKAGE
  const sasUrl = pulumi
    .all([storageAccountName, container.name, blob.name, args.resourceGroupName])
    .apply(([account, containerName, blobName, rg]) =>
      storage.listStorageAccountServiceSAS({
        accountName: account,
        resourceGroupName: rg,
        protocols: storage.HttpProtocol.Https,
        sharedAccessStartTime: new Date().toISOString(),
        sharedAccessExpiryTime: new Date(Date.now() + 365 * 86400000).toISOString(),
        resource: storage.SignedResource.B,
        permissions: storage.Permissions.R,
        canonicalizedResource: `/blob/${account}/${containerName}/${blobName}`,
      }),
    )
    .apply(
      (sas) =>
        pulumi.interpolate`https://${storageAccountName}.blob.core.windows.net/${container.name}/${blob.name}?${sas.serviceSasToken}`,
    )

  // Consumption plan
  const plan = new web.AppServicePlan(`${name}-plan`, {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    kind: 'functionapp',
    reserved: true,
    sku: { name: 'Y1', tier: 'Dynamic' },
  })

  const functionApp = new web.WebApp(name, {
    name,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    serverFarmId: plan.id,
    kind: 'functionapp,linux',
    identity: { type: web.ManagedServiceIdentityType.SystemAssigned },
    siteConfig: {
      linuxFxVersion: 'NODE|22',
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConnectionString },
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' },
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' },
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: sasUrl },
        { name: 'AZURE_KEYVAULT_NAME', value: args.keyVaultName },
        { name: 'AZURE_SUBSCRIPTION_ID', value: args.subscriptionId },
        { name: 'RENEW_BEFORE_DAYS', value: String(args.renewBeforeDays ?? 30) },
      ],
    },
  })

  const principalId = functionApp.identity.apply((id) => id?.principalId ?? '')

  // RBAC: Key Vault Secrets Officer
  new authorization.RoleAssignment(`${name}-kv-role`, {
    scope: args.keyVaultId,
    principalId,
    principalType: 'ServicePrincipal',
    roleDefinitionId: pulumi
      .output(args.subscriptionId)
      .apply(
        (sub) => `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${KV_SECRETS_OFFICER_ROLE}`,
      ),
  })

  // RBAC: DNS Zone Contributor on each zone
  pulumi.output(args.dnsZoneIds ?? []).apply((ids) => {
    for (const [i, zoneId] of (ids as string[]).entries()) {
      new authorization.RoleAssignment(`${name}-dns-role-${i}`, {
        scope: zoneId,
        principalId,
        principalType: 'ServicePrincipal',
        roleDefinitionId: pulumi
          .output(args.subscriptionId)
          .apply(
            (sub) =>
              `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${DNS_ZONE_CONTRIBUTOR_ROLE}`,
          ),
      })
    }
  })

  return { functionApp, identityPrincipalId: principalId }
}
