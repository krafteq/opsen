import * as pulumi from '@pulumi/pulumi'
import * as authorization from '@pulumi/azure-native/authorization'
import * as insights from '@pulumi/azure-native/insights'
import * as storage from '@pulumi/azure-native/storage'
import * as web from '@pulumi/azure-native/web'
import { AzureDeployer, AzureDeployParams } from '../deployer/base'

export interface CertRenewalFunctionDeployParams extends AzureDeployParams {
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
  /** Log Analytics Workspace ID. If provided, creates Application Insights and wires it to the function. */
  logAnalyticsWorkspaceId?: pulumi.Input<string>
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
 * Deploys an Azure Function App (Consumption plan, Node.js 22) that periodically
 * renews ACME certificates discovered in Key Vault.
 *
 * The function code is deployed from the pre-built zip in @opsen/cert-renewer.
 * All dependencies are bundled into a single file via esbuild (282KB zip).
 *
 * Assigns RBAC via system-assigned managed identity:
 *   - Key Vault Secrets Officer on the vault
 *   - DNS Zone Contributor on each DNS zone
 */
export class CertRenewalFunctionDeployer extends AzureDeployer<CertRenewalFunctionDeployParams> {
  deploy(): CertRenewalFunctionRef {
    const zipPath = this.params.functionZipPath ?? resolveDefaultFunctionZip()

    // Storage account for Function App runtime + zip hosting
    let storageAccountName: pulumi.Input<string>
    let storageConnectionString: pulumi.Input<string>

    if (this.params.storageAccount) {
      storageAccountName = this.params.storageAccount.name
      storageConnectionString = this.params.storageAccount.connectionString
    } else {
      const saName = this.name.replace(/[^a-z0-9]/g, '').substring(0, 24)
      const sa = new storage.StorageAccount(
        `${this.name}-sa`,
        {
          accountName: saName,
          resourceGroupName: this.resourceGroupName,
          location: this.location,
          kind: storage.Kind.StorageV2,
          sku: { name: storage.SkuName.Standard_LRS },
        },
        this.options(),
      )

      storageAccountName = sa.name

      storageConnectionString = pulumi
        .all([sa.name, this.resourceGroupName])
        .apply(([accountName, rg]) => storage.listStorageAccountKeys({ accountName, resourceGroupName: rg }))
        .apply(
          (keys) =>
            `DefaultEndpointsProtocol=https;AccountName=${saName};AccountKey=${keys.keys[0].value};EndpointSuffix=core.windows.net`,
        )
    }

    // Blob container + zip upload
    const container = new storage.BlobContainer(
      `${this.name}-releases`,
      {
        accountName: storageAccountName,
        resourceGroupName: this.resourceGroupName,
        containerName: 'function-releases',
        publicAccess: storage.PublicAccess.None,
      },
      this.options(),
    )

    const blob = new storage.Blob(
      `${this.name}-zip`,
      {
        accountName: storageAccountName,
        resourceGroupName: this.resourceGroupName,
        containerName: container.name,
        blobName: `cert-renewer-${Date.now()}.zip`,
        source: new pulumi.asset.FileAsset(zipPath),
        contentType: 'application/zip',
      },
      this.options(),
    )

    // Generate SAS URL for WEBSITE_RUN_FROM_PACKAGE
    const sasUrl = pulumi
      .all([storageAccountName, container.name, blob.name, this.resourceGroupName])
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

    // Application Insights (optional — requires Log Analytics workspace)
    let appInsightsSettings: { name: string; value: pulumi.Input<string> }[] = []
    if (this.params.logAnalyticsWorkspaceId) {
      const appInsights = new insights.Component(
        `${this.name}-ai`,
        {
          resourceGroupName: this.resourceGroupName,
          location: this.location,
          kind: 'web',
          applicationType: insights.ApplicationType.Web,
          ingestionMode: insights.IngestionMode.LogAnalytics,
          workspaceResourceId: this.params.logAnalyticsWorkspaceId,
          retentionInDays: 30,
        },
        this.options(),
      )
      appInsightsSettings = [
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.instrumentationKey },
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.connectionString },
      ]
    }

    // Consumption plan
    const plan = new web.AppServicePlan(
      `${this.name}-plan`,
      {
        resourceGroupName: this.resourceGroupName,
        location: this.location,
        kind: 'functionapp',
        reserved: true,
        sku: { name: 'Y1', tier: 'Dynamic' },
      },
      this.options(),
    )

    const functionApp = new web.WebApp(
      this.name,
      {
        name: this.name,
        resourceGroupName: this.resourceGroupName,
        location: this.location,
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
            { name: 'AZURE_KEYVAULT_NAME', value: this.params.keyVaultName },
            { name: 'AZURE_SUBSCRIPTION_ID', value: this.params.subscriptionId },
            { name: 'RENEW_BEFORE_DAYS', value: String(this.params.renewBeforeDays ?? 30) },
            ...appInsightsSettings,
          ],
        },
      },
      this.options(),
    )

    const principalId = functionApp.identity.apply((id) => id?.principalId ?? '')

    // RBAC: Key Vault Secrets Officer
    new authorization.RoleAssignment(
      `${this.name}-kv-role`,
      {
        scope: this.params.keyVaultId,
        principalId,
        principalType: 'ServicePrincipal',
        roleDefinitionId: pulumi
          .output(this.params.subscriptionId)
          .apply(
            (sub) =>
              `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${KV_SECRETS_OFFICER_ROLE}`,
          ),
      },
      this.options(),
    )

    // RBAC: DNS Zone Contributor on each zone
    pulumi.output(this.params.dnsZoneIds ?? []).apply((ids) => {
      for (const [i, zoneId] of (ids as string[]).entries()) {
        new authorization.RoleAssignment(
          `${this.name}-dns-role-${i}`,
          {
            scope: zoneId,
            principalId,
            principalType: 'ServicePrincipal',
            roleDefinitionId: pulumi
              .output(this.params.subscriptionId)
              .apply(
                (sub) =>
                  `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${DNS_ZONE_CONTRIBUTOR_ROLE}`,
              ),
          },
          this.options(),
        )
      }
    })

    return { functionApp, identityPrincipalId: principalId }
  }
}
