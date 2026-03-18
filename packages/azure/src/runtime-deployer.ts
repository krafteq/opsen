import * as pulumi from '@pulumi/pulumi'
import * as network from '@pulumi/azure-native/network'
import { RuntimeDeployer, Workload, WorkloadMetadata, DeployedWorkload, DeployedServiceEndpoint } from '@opsen/platform'
import type { AzureRuntime } from './runtime'
import { ContainerAppDeployer, ContainerAppRegistry } from './deployer/container-app'
import { buildContainerAppSpec } from './building-blocks/build-container-app-spec'
import { buildAppGatewayEntries } from './building-blocks/build-app-gateway-entries'
import { AppGatewayRef, AzureConnection } from './app-gateway'
import {
  AcmeCertificate,
  AppGatewaySslCertificate,
  AppGatewayBackendPool,
  AppGatewayProbe,
  AppGatewayBackendSettings,
  AppGatewayHttpListener,
  AppGatewayRoutingRule,
} from './app-gateway/providers'

export interface AppGatewayAcmeConfig {
  email: string
  dnsZoneResourceGroup: string
  dnsZoneName: string
  keyVaultName: string
  staging?: boolean
}

export interface AzureRuntimeDeployerArgs {
  /** Azure Container Apps Environment ID */
  environmentId: pulumi.Input<string>
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Container registry credentials */
  registries?: ContainerAppRegistry[]
  /** Storage account for persistent volumes (AzureFile) */
  storageAccount?: { name: string; key: pulumi.Input<string>; shareName: string }
  /** Workload profile name (moved from workload hint to deployer arg) */
  workloadProfileName?: string
  /** App Gateway reference for WAF-enabled endpoints */
  appGateway?: AppGatewayRef
  /** ACME configuration for automatic TLS certificates */
  acme?: AppGatewayAcmeConfig
  /** Azure connection for dynamic providers (required when appGateway is set) */
  connection?: pulumi.Input<AzureConnection>
}

/**
 * Azure Container Apps RuntimeDeployer.
 * Maps each process to a separate ContainerApp for independent scaling.
 * ACA handles ingress natively — no proxy needed.
 */
export class AzureRuntimeDeployer implements RuntimeDeployer<AzureRuntime> {
  readonly runtimeKind = 'azure-aca'

  private args: AzureRuntimeDeployerArgs
  private deployer: ContainerAppDeployer
  private storageAccount?: AzureRuntimeDeployerArgs['storageAccount']
  private workloadProfileName?: string

  constructor(args: AzureRuntimeDeployerArgs) {
    this.args = args
    this.deployer = new ContainerAppDeployer({
      environmentId: args.environmentId,
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      registries: args.registries,
    })
    this.storageAccount = args.storageAccount
    this.workloadProfileName = args.workloadProfileName
  }

  deploy(workload: Workload<AzureRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload> {
    return pulumi.output(workload).apply((wl) => {
      const processes: Record<string, {}> = {}
      const endpointOutputs: Record<string, pulumi.Input<DeployedServiceEndpoint>> = {}

      // Deploy each process as a separate ContainerApp
      for (const [processName, process] of Object.entries(wl.processes ?? {})) {
        if (process.disabled) continue

        const appName = `${metadata.name}-${processName}`
        const spec = buildContainerAppSpec(wl, metadata, processName, process, {
          storageName: this.storageAccount?.name,
          workloadProfileName: this.workloadProfileName,
        })
        const deployed = this.deployer.deploy(spec)
        processes[processName] = {}

        // Wire WAF endpoints through App Gateway if configured
        if (this.args.appGateway && this.args.acme && this.args.connection) {
          const gwEntries = buildAppGatewayEntries(wl, metadata, processName, process, {
            backendFqdn: '__placeholder__',
          })
          for (const entry of gwEntries) {
            this.wireAppGatewayEndpoint(entry.namePrefix, entry, deployed.fqdn)
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
            // External ingress — use the first custom domain or ACA FQDN
            const firstHost = (endpoint.ingress.hosts as string[])[0]
            endpointOutputs[endpointName] = {
              host: firstHost ?? deployed.fqdn,
              port: 443,
            }
          } else {
            // Internal — use ACA FQDN (internal ingress within environment)
            endpointOutputs[endpointName] = deployed.fqdn.apply((fqdn) => ({
              host: fqdn || `${appName}.internal`,
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
    backendFqdn: pulumi.Output<string>,
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

    // 2. SSL certificate on App Gateway (references KV secret)
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
      fqdns: [backendFqdn],
    })

    // 4. Health probe (optional)
    let probeId: pulumi.Output<string> | undefined
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
      probeId = pulumi.interpolate`${gw.resourceIdPrefix}/probes/${namePrefix}`
    }

    // 5. Backend HTTP settings
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
