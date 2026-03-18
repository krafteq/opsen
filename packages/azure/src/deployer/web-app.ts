import * as web from '@pulumi/azure-native/web'
import { input as inputs } from '@pulumi/azure-native/types'
import * as pulumi from '@pulumi/pulumi'
import { AzureDeployer, AzureDeployParams } from './base'

export interface WebAppDeployParams extends AzureDeployParams {
  /** App Service Plan ID */
  appServicePlanId: pulumi.Input<string>
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
  /** Application Insights connection string. If provided, wires APPLICATIONINSIGHTS_CONNECTION_STRING into each web app. */
  appInsightsConnectionString?: pulumi.Input<string>
}

export interface WebAppSpec {
  name: string
  image: string
  appSettings: Record<string, pulumi.Input<string>>
  connectionStrings?: Record<string, { value: pulumi.Input<string>; type: string }>
  storageMounts?: WebAppStorageMount[]
  healthCheckPath?: string
  port?: number
  customHostnames?: string[]
  alwaysOn?: boolean
}

export interface WebAppStorageMount {
  name: string
  mountPath: string
  shareName: string
  storageAccountName: string
  storageAccountKey: pulumi.Input<string>
  accessMode: 'ReadWrite' | 'ReadOnly'
}

export interface DeployedWebApp {
  app: web.WebApp
  defaultHostname: pulumi.Output<string>
}

/**
 * Deploys an Azure Linux Web App for Containers.
 * Supports Key Vault secret references, Azure Files mounts, health checks, and custom hostnames.
 */
export class WebAppDeployer extends AzureDeployer<WebAppDeployParams> {
  deploy(spec: WebAppSpec): DeployedWebApp {
    const appSettings: inputs.web.NameValuePairArgs[] = []

    // Docker registry (only when a private registry is configured)
    if (this.params.registry) {
      appSettings.push({ name: 'DOCKER_REGISTRY_SERVER_URL', value: `https://${this.params.registry.server}` })
      if (this.params.registry.username) {
        appSettings.push({ name: 'DOCKER_REGISTRY_SERVER_USERNAME', value: this.params.registry.username })
      }
      if (this.params.registry.password) {
        appSettings.push({ name: 'DOCKER_REGISTRY_SERVER_PASSWORD', value: this.params.registry.password })
      }
    }

    // Port
    if (spec.port) {
      appSettings.push({ name: 'WEBSITES_PORT', value: String(spec.port) })
    }

    // Application Insights
    if (this.params.appInsightsConnectionString) {
      appSettings.push({
        name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
        value: this.params.appInsightsConnectionString,
      })
      // Extract instrumentation key from connection string and enable auto-instrumentation agent
      appSettings.push({
        name: 'APPINSIGHTS_INSTRUMENTATIONKEY',
        value: pulumi
          .output(this.params.appInsightsConnectionString)
          .apply((cs) => cs.match(/InstrumentationKey=([^;]+)/)?.[1] ?? ''),
      })
      appSettings.push({ name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' })
    }

    // User app settings
    for (const [name, value] of Object.entries(spec.appSettings)) {
      appSettings.push({ name, value })
    }

    const appResource = new web.WebApp(
      spec.name,
      {
        name: spec.name,
        resourceGroupName: this.resourceGroupName,
        location: this.location,
        serverFarmId: this.params.appServicePlanId,
        httpsOnly: true,
        identity: {
          type: web.ManagedServiceIdentityType.SystemAssigned,
        },
        siteConfig: {
          linuxFxVersion: `DOCKER|${spec.image}`,
          alwaysOn: spec.alwaysOn ?? true,
          healthCheckPath: spec.healthCheckPath,
          appSettings,
        },
      },
      this.options(),
    )

    // Storage mounts via separate resource
    if (spec.storageMounts && spec.storageMounts.length > 0) {
      const storageProperties: Record<string, pulumi.Input<inputs.web.AzureStorageInfoValueArgs>> = {}
      for (const mount of spec.storageMounts) {
        storageProperties[mount.name] = {
          type: web.AzureStorageType.AzureFiles,
          accountName: mount.storageAccountName,
          accessKey: mount.storageAccountKey,
          shareName: mount.shareName,
          mountPath: mount.mountPath,
        }
      }

      new web.WebAppAzureStorageAccounts(
        `${spec.name}-storage`,
        {
          name: appResource.name,
          resourceGroupName: this.resourceGroupName,
          properties: storageProperties,
        },
        this.options({ parent: appResource }),
      )
    }

    // Bind custom hostnames
    for (const hostname of spec.customHostnames ?? []) {
      new web.WebAppHostNameBinding(
        `${spec.name}-${hostname.replace(/\./g, '-')}`,
        {
          name: appResource.name,
          resourceGroupName: this.resourceGroupName,
          hostName: hostname,
        },
        this.options({ parent: appResource }),
      )
    }

    const defaultHostname = appResource.defaultHostName.apply((h) => h ?? '')

    return { app: appResource, defaultHostname }
  }
}

/** @deprecated Use WebAppDeployParams instead */
export type WebAppDeployerArgs = WebAppDeployParams
