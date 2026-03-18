import * as web from '@pulumi/azure-native/web'
import { input as inputs } from '@pulumi/azure-native/types'
import * as pulumi from '@pulumi/pulumi'

export interface WebAppDeployerArgs {
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
export class WebAppDeployer {
  constructor(private readonly args: WebAppDeployerArgs) {}

  deploy(spec: WebAppSpec): DeployedWebApp {
    const appSettings: inputs.web.NameValuePairArgs[] = []

    // Docker registry (only when a private registry is configured)
    if (this.args.registry) {
      appSettings.push({ name: 'DOCKER_REGISTRY_SERVER_URL', value: `https://${this.args.registry.server}` })
      if (this.args.registry.username) {
        appSettings.push({ name: 'DOCKER_REGISTRY_SERVER_USERNAME', value: this.args.registry.username })
      }
      if (this.args.registry.password) {
        appSettings.push({ name: 'DOCKER_REGISTRY_SERVER_PASSWORD', value: this.args.registry.password })
      }
    }

    // Port
    if (spec.port) {
      appSettings.push({ name: 'WEBSITES_PORT', value: String(spec.port) })
    }

    // User app settings
    for (const [name, value] of Object.entries(spec.appSettings)) {
      appSettings.push({ name, value })
    }

    const app = new web.WebApp(spec.name, {
      name: spec.name,
      resourceGroupName: this.args.resourceGroupName,
      location: this.args.location,
      serverFarmId: this.args.appServicePlanId,
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
    })

    // Storage mounts via separate resource (web.WebApp doesn't support inline azureStorageAccounts)
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
          name: app.name,
          resourceGroupName: this.args.resourceGroupName,
          properties: storageProperties,
        },
        { parent: app },
      )
    }

    // Bind custom hostnames
    for (const hostname of spec.customHostnames ?? []) {
      new web.WebAppHostNameBinding(
        `${spec.name}-${hostname.replace(/\./g, '-')}`,
        {
          name: app.name,
          resourceGroupName: this.args.resourceGroupName,
          hostName: hostname,
        },
        { parent: app },
      )
    }

    const defaultHostname = app.defaultHostName.apply((h) => h ?? '')

    return { app, defaultHostname }
  }
}
