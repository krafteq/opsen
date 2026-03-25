import * as pulumi from '@pulumi/pulumi'
import {
  Workload,
  WorkloadProcess,
  WorkloadMetadata,
  EnvVarValue,
  isSecretValue,
  isSecretRef,
  resolveEnvValue,
} from '@opsen/platform'
import type { AzureRuntime } from '../runtime'
import { WebAppSpec, WebAppStorageMount } from '../deployer/web-app'

export interface BuildWebAppSpecOptions {
  /** Key Vault URL for secret references */
  kvVaultUrl: string
  /** Storage account for Azure Files mounts (persistent volumes + files) */
  storageAccount?: { name: string; key: pulumi.Input<string>; shareName: string }
  /** Override the resource name. Defaults to `${metadata.name}-${processName}`. */
  name?: string
}

/**
 * Build a `WebAppSpec` from a workload, metadata, and a single process.
 *
 * This is a pure data-transform — no cloud resources are created.
 * Use with `WebAppDeployer.deploy()` or `deployWebApp()` to actually deploy.
 *
 * Secret env vars use Key Vault references: `@Microsoft.KeyVault(SecretUri=...)`.
 * Files are mounted via Azure Files (real mount at real path).
 * Persistent volumes use Azure Files storage mounts.
 */
export function buildWebAppSpec(
  wl: pulumi.Unwrap<Workload<AzureRuntime>>,
  metadata: WorkloadMetadata,
  processName: string,
  process: pulumi.Unwrap<WorkloadProcess<AzureRuntime>>,
  options: BuildWebAppSpecOptions,
): WebAppSpec {
  const appName = options.name ?? `${metadata.name}-${processName}`

  const image = process.image ?? wl.image
  if (!image) {
    throw new Error(`No image specified for process ${processName} in ${metadata.name}`)
  }

  // Merge env from workload + process
  const rawEnv = {
    ...(wl.env ?? {}),
    ...(process.env ?? {}),
  }

  const appSettings: Record<string, pulumi.Input<string>> = {}
  for (const [name, value] of Object.entries(rawEnv)) {
    if (value === undefined) continue
    if (typeof value === 'string') {
      appSettings[name] = value
    } else if (isSecretValue(value as EnvVarValue)) {
      // Inline secret — extract value directly (Web App stores as app setting)
      appSettings[name] = resolveEnvValue(value as EnvVarValue)
    } else if (isSecretRef(value as EnvVarValue)) {
      // SecretRef with keyvault + secret → Key Vault reference
      const ref = (value as { type: 'secret'; valueRef: Record<string, string> }).valueRef
      if (ref.keyvault && ref.secret) {
        appSettings[name] =
          `@Microsoft.KeyVault(SecretUri=https://${ref.keyvault}.vault.azure.net/secrets/${ref.secret})`
      } else {
        throw new Error(
          `SecretRef for key "${name}" must have 'keyvault' and 'secret' fields for Azure Web App deployment`,
        )
      }
    }
  }

  // Storage mounts for persistent volumes
  const storageMounts: WebAppStorageMount[] = []
  const processVolumes = {
    ...(wl.volumes ?? {}),
    ...(process.volumes ?? {}),
  }

  for (const [volName, volSpec] of Object.entries(processVolumes)) {
    if (volSpec._az?.persistent && options.storageAccount) {
      storageMounts.push({
        name: volName,
        mountPath: volSpec.path,
        shareName: options.storageAccount.shareName,
        storageAccountName: options.storageAccount.name,
        storageAccountKey: options.storageAccount.key,
        accessMode: 'ReadWrite',
      })
    }
  }

  // Files → Azure Files mounts (real path)
  const allFiles = [...(wl.files ?? []), ...(process.files ?? [])]
  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i]
    if (options.storageAccount) {
      storageMounts.push({
        name: `file-${i}`,
        mountPath: file.path.substring(0, file.path.lastIndexOf('/')) || '/',
        shareName: options.storageAccount.shareName,
        storageAccountName: options.storageAccount.name,
        storageAccountKey: options.storageAccount.key,
        accessMode: 'ReadOnly',
      })
    }
  }

  // Health check — liveness http-get → healthCheckPath
  let healthCheckPath: string | undefined
  const healthcheck = {
    ...(wl.healthcheck ?? {}),
    ...(process.healthcheck ?? {}),
  }
  if (healthcheck.liveness?.action.type === 'http-get') {
    healthCheckPath = healthcheck.liveness.action.httpGet.path
  }

  // Port + custom hostnames from endpoints
  let port: number | undefined
  const customHostnames: string[] = []

  for (const [, endpoint] of Object.entries(wl.endpoints ?? {})) {
    if (endpoint.backend.process !== processName) continue

    const backendPort = process.ports?.[endpoint.backend.port]
    if (backendPort) {
      port = backendPort.port
    }

    // Skip custom hostname binding for WAF endpoints — traffic routes through
    // App Gateway using the Web App's default *.azurewebsites.net hostname as backend.
    if (endpoint.ingress?.hosts && !endpoint.ingress?._az?.waf) {
      const hosts = endpoint.ingress.hosts as string[]
      customHostnames.push(...hosts)
    }
  }

  return {
    name: appName,
    image: image as string,
    appSettings,
    storageMounts: storageMounts.length > 0 ? storageMounts : undefined,
    healthCheckPath,
    port,
    customHostnames: customHostnames.length > 0 ? customHostnames : undefined,
    alwaysOn: true,
  }
}
