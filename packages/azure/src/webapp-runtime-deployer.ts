import * as pulumi from '@pulumi/pulumi'
import * as network from '@pulumi/azure-native/network'
import { RuntimeDeployer, Workload, WorkloadMetadata, DeployedWorkload, DeployedServiceEndpoint } from '@opsen/platform'
import type { AzureRuntime } from './runtime'
import { WebAppDeployer } from './deployer/web-app'
import { buildWebAppSpec } from './building-blocks/build-webapp-spec'
import { buildAppGatewayEntries } from './building-blocks/build-app-gateway-entries'
import { AppGatewayRef, AzureConnection } from './app-gateway'
import { AppGatewayAcmeConfig } from './runtime-deployer'
import {
  AcmeCertificate,
  AppGatewaySslCertificate,
  AppGatewayBackendPool,
  AppGatewayProbe,
  AppGatewayBackendSettings,
  AppGatewayHttpListener,
  AppGatewayRoutingRule,
} from './app-gateway/providers'

export interface AzureWebAppDeployerArgs {
  /** App Service Plan ID */
  appServicePlanId: pulumi.Input<string>
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Key Vault for secret references */
  keyVault: { vaultUrl: string; identityId?: pulumi.Input<string> }
  /** Storage account for Azure Files mounts */
  storageAccount?: { name: string; key: pulumi.Input<string>; shareName: string }
  /** Container registry credentials */
  registry?: {
    server: string
    username?: string
    password?: pulumi.Input<string>
    identityId?: string
  }
  /** App Gateway reference for WAF-enabled endpoints */
  appGateway?: AppGatewayRef
  /** ACME configuration for automatic TLS certificates */
  acme?: AppGatewayAcmeConfig
  /** Azure connection for dynamic providers (required when appGateway is set) */
  connection?: pulumi.Input<AzureConnection>
}

/**
 * Azure Web App for Containers RuntimeDeployer.
 * Maps each process to a separate Linux Web App with Key Vault refs and Azure Files mounts.
 */
export class AzureWebAppRuntimeDeployer implements RuntimeDeployer<AzureRuntime> {
  readonly runtimeKind = 'azure-webapp'

  private args: AzureWebAppDeployerArgs
  private deployer: WebAppDeployer
  private storageAccount?: AzureWebAppDeployerArgs['storageAccount']
  private kvVaultUrl: string

  constructor(args: AzureWebAppDeployerArgs) {
    this.args = args
    this.deployer = new WebAppDeployer({
      appServicePlanId: args.appServicePlanId,
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      keyVault: args.keyVault,
      storageAccount: args.storageAccount,
      registry: args.registry,
    })
    this.storageAccount = args.storageAccount
    this.kvVaultUrl = args.keyVault.vaultUrl
  }

  deploy(workload: Workload<AzureRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload> {
    return pulumi.output(workload).apply((wl) => {
      const processes: Record<string, {}> = {}
      const endpointOutputs: Record<string, pulumi.Input<DeployedServiceEndpoint>> = {}

      for (const [processName, process] of Object.entries(wl.processes ?? {})) {
        if (process.disabled) continue

        const spec = buildWebAppSpec(wl, metadata, processName, process, {
          kvVaultUrl: this.kvVaultUrl,
          storageAccount: this.storageAccount,
        })
        const deployed = this.deployer.deploy(spec)
        processes[processName] = {}

        // Wire WAF endpoints through App Gateway if configured
        if (this.args.appGateway && this.args.acme && this.args.connection) {
          const gwEntries = buildAppGatewayEntries(wl, metadata, processName, process, {
            backendFqdn: '__placeholder__',
          })
          for (const entry of gwEntries) {
            this.wireAppGatewayEndpoint(entry.namePrefix, entry, deployed.defaultHostname)
          }
        }

        // Resolve endpoints targeting this process
        for (const [endpointName, endpoint] of Object.entries(wl.endpoints ?? {})) {
          if (endpoint.backend.process !== processName) continue

          const backendPort = process.ports?.[endpoint.backend.port]
          const port = endpoint.servicePort ?? backendPort?.port ?? 443

          if (endpoint.ingress?._az?.waf && this.args.appGateway) {
            // WAF endpoint — resolves to App Gateway public IP
            const firstHost = (endpoint.ingress.hosts as string[])?.[0]
            if (firstHost) {
              endpointOutputs[endpointName] = { host: firstHost, port: 443 }
            }
          } else if (endpoint.ingress?.hosts) {
            const firstHost = (endpoint.ingress.hosts as string[])[0]
            endpointOutputs[endpointName] = {
              host: firstHost ?? deployed.defaultHostname,
              port: 443,
            }
          } else {
            endpointOutputs[endpointName] = deployed.defaultHostname.apply((hostname) => ({
              host: hostname || `${metadata.name}-${processName}.azurewebsites.net`,
              port,
            }))
          }
        }
      }

      return pulumi.all(endpointOutputs).apply((endpoints) => ({
        processes,
        endpoints,
      }))
    })
  }

  private wireAppGatewayEndpoint(
    namePrefix: string,
    entry: ReturnType<typeof buildAppGatewayEntries>[number],
    backendHostname: pulumi.Output<string>,
  ): void {
    const gw = this.args.appGateway!
    const acme = this.args.acme!
    const conn = this.args.connection!

    // 1. ACME certificate → Key Vault
    const cert = new AcmeCertificate(`${namePrefix}-cert`, {
      connection: conn,
      domain: entry.hostName,
      dnsZoneResourceGroup: acme.dnsZoneResourceGroup,
      dnsZoneName: acme.dnsZoneName,
      keyVaultName: acme.keyVaultName,
      acmeEmail: acme.email,
      staging: acme.staging,
    })

    // 2. SSL certificate on App Gateway
    new AppGatewaySslCertificate(`${namePrefix}-ssl`, {
      connection: conn,
      gatewayName: gw.gatewayName,
      name: namePrefix,
      keyVaultSecretId: cert.keyVaultSecretId,
    })

    // 3. Backend pool
    new AppGatewayBackendPool(`${namePrefix}-pool`, {
      connection: conn,
      gatewayName: gw.gatewayName,
      name: namePrefix,
      fqdns: [backendHostname],
    })

    // 4. Health probe (optional)
    if (entry.probe) {
      new AppGatewayProbe(`${namePrefix}-probe`, {
        connection: conn,
        gatewayName: gw.gatewayName,
        name: namePrefix,
        protocol: entry.probe.protocol,
        path: entry.probe.path,
        interval: entry.probe.interval,
        timeout: entry.probe.timeout,
        unhealthyThreshold: entry.probe.unhealthyThreshold,
      })
    }

    // 5. Backend HTTP settings
    const probeId = entry.probe ? pulumi.interpolate`${gw.resourceIdPrefix}/probes/${namePrefix}` : undefined

    new AppGatewayBackendSettings(`${namePrefix}-settings`, {
      connection: conn,
      gatewayName: gw.gatewayName,
      name: namePrefix,
      port: entry.backendPort,
      protocol: 'Https',
      pickHostNameFromBackendAddress: true,
      probeId,
    })

    // 6. HTTPS listener
    new AppGatewayHttpListener(`${namePrefix}-listener`, {
      connection: conn,
      gatewayName: gw.gatewayName,
      name: namePrefix,
      hostName: entry.hostName,
      protocol: 'Https',
      frontendIpConfigurationId: gw.frontendIpConfigId,
      frontendPortId: gw.frontendPort443Id,
      sslCertificateId: pulumi.interpolate`${gw.resourceIdPrefix}/sslCertificates/${namePrefix}`,
    })

    // 7. Routing rule
    new AppGatewayRoutingRule(`${namePrefix}-rule`, {
      connection: conn,
      gatewayName: gw.gatewayName,
      name: namePrefix,
      priority: entry.priority,
      httpListenerId: pulumi.interpolate`${gw.resourceIdPrefix}/httpListeners/${namePrefix}`,
      backendAddressPoolId: pulumi.interpolate`${gw.resourceIdPrefix}/backendAddressPools/${namePrefix}`,
      backendHttpSettingsId: pulumi.interpolate`${gw.resourceIdPrefix}/backendHttpSettingsCollection/${namePrefix}`,
    })

    // 8. DNS A record → App Gateway public IP
    new network.RecordSet(`${namePrefix}-dns`, {
      resourceGroupName: acme.dnsZoneResourceGroup,
      zoneName: acme.dnsZoneName,
      relativeRecordSetName: entry.hostName.replace(`.${acme.dnsZoneName}`, ''),
      recordType: 'A',
      ttl: 300,
      aRecords: [{ ipv4Address: gw.publicIpAddress }],
    })
  }
}
