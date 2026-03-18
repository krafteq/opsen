import * as pulumi from '@pulumi/pulumi'
import * as app from '@pulumi/azure-native/app'
import * as authorization from '@pulumi/azure-native/authorization'
import { AzureDeployer, AzureDeployParams } from '../deployer/base'
import { getAzureToken, azureApiRequest, ARM_SCOPE, AzureConnection } from './azure-connection'

export interface CertRenewalJobDeployParams extends AzureDeployParams {
  /** Container Apps Environment ID */
  environmentId: pulumi.Input<string>
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

// Key Vault Secrets Officer
const KV_SECRETS_OFFICER_ROLE = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
// DNS Zone Contributor
const DNS_ZONE_CONTRIBUTOR_ROLE = 'befefa01-2a29-4197-83a8-272ff33ce314'

/**
 * Deploys a Container App Job that periodically renews ACME certificates.
 *
 * The job scans Key Vault for secrets tagged `opsen-managed: true`,
 * checks expiry, and re-issues via Let's Encrypt DNS-01 if needed.
 *
 * Assigns RBAC:
 *   - Key Vault Secrets Officer on the vault
 *   - DNS Zone Contributor on each DNS zone
 */
export class CertRenewalJobDeployer extends AzureDeployer<CertRenewalJobDeployParams> {
  deploy(): CertRenewalJobRef {
    const job = new app.Job(
      this.name,
      {
        jobName: this.name,
        resourceGroupName: this.resourceGroupName,
        environmentId: this.params.environmentId,
        location: this.location,
        identity: {
          type: 'UserAssigned',
        },
        configuration: {
          triggerType: 'Schedule',
          scheduleTriggerConfig: {
            cronExpression: this.params.schedule ?? '0 3 * * *',
          },
          replicaTimeout: 600,
          replicaRetryLimit: 1,
        },
        template: {
          containers: [
            {
              name: 'cert-renewer',
              image: this.params.image,
              env: [
                { name: 'AZURE_KEYVAULT_NAME', value: this.params.keyVaultName },
                { name: 'AZURE_SUBSCRIPTION_ID', value: this.params.subscriptionId },
                { name: 'RENEW_BEFORE_DAYS', value: String(this.params.renewBeforeDays ?? 30) },
              ],
              resources: { cpu: 0.25, memory: '0.5Gi' },
            },
          ],
        },
      },
      this.options(),
    )

    const principalId = job.identity.apply((id) => id?.principalId ?? '')

    // Key Vault Secrets Officer role
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

    // DNS Zone Contributor role on each zone
    const dnsZoneIds = pulumi.output(this.params.dnsZoneIds ?? [])
    dnsZoneIds.apply((ids) => {
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

    return { job, identityPrincipalId: principalId }
  }
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
