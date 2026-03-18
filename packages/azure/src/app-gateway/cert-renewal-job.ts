import * as pulumi from '@pulumi/pulumi'
import * as app from '@pulumi/azure-native/app'
import * as authorization from '@pulumi/azure-native/authorization'
import { getAzureToken, azureApiRequest, ARM_SCOPE, AzureConnection } from './azure-connection'

export interface CertRenewalJobArgs {
  /** Container Apps Environment ID */
  environmentId: pulumi.Input<string>
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Azure subscription ID (for DNS zone access) */
  subscriptionId: pulumi.Input<string>
  /** Key Vault name to scan for certs */
  keyVaultName: pulumi.Input<string>
  /** Docker image for the cert-renewer (e.g. ghcr.io/org/cert-renewer:latest) */
  image: pulumi.Input<string>
  /** Cron schedule (default: "0 3 * * *" = daily at 3am UTC) */
  schedule?: pulumi.Input<string>
  /** Renew when certificate has fewer than N days remaining (default: 30) */
  renewBeforeDays?: number
  /** Key Vault resource ID (for RBAC assignment) */
  keyVaultId: pulumi.Input<string>
  /** DNS zone resource IDs to grant contributor access (for TXT record management) */
  dnsZoneIds?: pulumi.Input<pulumi.Input<string>[]>
  /** Azure connection for triggering the job after Pulumi creates cert placeholders */
  connection?: pulumi.Input<AzureConnection>
}

export interface CertRenewalJobRef {
  job: app.Job
  identityPrincipalId: pulumi.Output<string>
}

/**
 * Deploy a Container App Job that periodically renews ACME certificates.
 *
 * The job scans Key Vault for secrets tagged `opsen-managed: true`,
 * checks expiry, and re-issues via Let's Encrypt DNS-01 if needed.
 *
 * Assigns RBAC:
 *   - Key Vault Secrets Officer on the vault
 *   - DNS Zone Contributor on each DNS zone
 */
export function createCertRenewalJob(name: string, args: CertRenewalJobArgs): CertRenewalJobRef {
  const job = new app.Job(name, {
    jobName: name,
    resourceGroupName: args.resourceGroupName,
    environmentId: args.environmentId,
    location: args.location,
    identity: {
      type: 'UserAssigned',
    },
    configuration: {
      triggerType: 'Schedule',
      scheduleTriggerConfig: {
        cronExpression: args.schedule ?? '0 3 * * *',
      },
      replicaTimeout: 600,
      replicaRetryLimit: 1,
    },
    template: {
      containers: [
        {
          name: 'cert-renewer',
          image: args.image,
          env: [
            { name: 'AZURE_KEYVAULT_NAME', value: args.keyVaultName },
            { name: 'AZURE_SUBSCRIPTION_ID', value: args.subscriptionId },
            { name: 'RENEW_BEFORE_DAYS', value: String(args.renewBeforeDays ?? 30) },
          ],
          resources: { cpu: 0.25, memory: '0.5Gi' },
        },
      ],
    },
  })

  const principalId = job.identity.apply((id) => id?.principalId ?? '')

  // Key Vault Secrets Officer role
  // Role ID: b86a8fe4-44ce-4948-aee5-eccb2c155cd7
  new authorization.RoleAssignment(`${name}-kv-role`, {
    scope: args.keyVaultId,
    principalId,
    principalType: 'ServicePrincipal',
    roleDefinitionId: pulumi
      .output(args.subscriptionId)
      .apply(
        (sub) =>
          `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7`,
      ),
  })

  // DNS Zone Contributor role on each zone
  // Role ID: befefa01-2a29-4197-83a8-272ff33ce314
  const dnsZoneIds = pulumi.output(args.dnsZoneIds ?? [])
  dnsZoneIds.apply((ids) => {
    for (const [i, zoneId] of (ids as string[]).entries()) {
      new authorization.RoleAssignment(`${name}-dns-role-${i}`, {
        scope: zoneId,
        principalId,
        principalType: 'ServicePrincipal',
        roleDefinitionId: pulumi
          .output(args.subscriptionId)
          .apply(
            (sub) =>
              `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/befefa01-2a29-4197-83a8-272ff33ce314`,
          ),
      })
    }
  })

  return { job, identityPrincipalId: principalId }
}

/**
 * Trigger a manual execution of the cert renewal job.
 * Use after `pulumi up` creates new AcmeCertificate placeholders.
 */
export async function triggerCertRenewalJob(connection: AzureConnection, jobName: string): Promise<void> {
  const token = await getAzureToken(connection, ARM_SCOPE)
  const url =
    `https://management.azure.com/subscriptions/${connection.subscriptionId}` +
    `/resourceGroups/${connection.resourceGroupName}` +
    `/providers/Microsoft.App/jobs/${jobName}/start` +
    `?api-version=2024-03-01`

  await azureApiRequest('POST', url, token, {})
}
