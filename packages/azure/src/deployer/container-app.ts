import * as app from '@pulumi/azure-native/app'
import { input as inputs } from '@pulumi/azure-native/types'
import * as pulumi from '@pulumi/pulumi'
import { AzureDeployer, AzureDeployParams } from './base'

export interface ContainerAppDeployParams extends AzureDeployParams {
  /** Azure Container Apps Environment ID */
  environmentId: pulumi.Input<string>
  /** Container registry credentials */
  registries?: ContainerAppRegistry[]
}

export interface ContainerAppRegistry {
  server: string
  username?: string
  passwordSecretRef?: string
  identity?: string
}

export interface ContainerAppSpec {
  name: string
  image: string
  command?: string[]
  env?: Record<string, string | undefined>
  /** Secret env vars — value is stored as ACA secret, referenced by secretRef */
  secretEnv?: Record<string, pulumi.Input<string>>
  cpuCores?: number
  memoryGi?: number
  minReplicas?: number
  maxReplicas?: number
  targetPort?: number
  external?: boolean
  /** HTTP transport method: auto, http, http2, tcp */
  transport?: string
  allowInsecure?: boolean
  corsPolicy?: {
    allowedOrigins: string[]
    allowedMethods?: string[]
    allowedHeaders?: string[]
    allowCredentials?: boolean
    maxAge?: number
  }
  customDomains?: { name: string; certificateId?: string }[]
  volumes?: ContainerAppVolumeSpec[]
  probes?: ContainerAppProbeSpec[]
  /** File contents to mount as a secret volume */
  files?: { path: string; content: pulumi.Input<string> }[]
  workloadProfileName?: string
}

export interface ContainerAppVolumeSpec {
  name: string
  mountPath: string
  storageType: 'AzureFile' | 'EmptyDir'
  storageName?: string
}

export interface ContainerAppProbeSpec {
  type: 'Liveness' | 'Readiness' | 'Startup'
  httpGet?: { path: string; port: number }
  tcpSocket?: { port: number }
  exec?: { command: string[] }
  initialDelaySeconds?: number
  periodSeconds?: number
  timeoutSeconds?: number
  failureThreshold?: number
  successThreshold?: number
}

export interface DeployedContainerApp {
  app: app.ContainerApp
  fqdn: pulumi.Output<string>
}

/**
 * Deploys an Azure Container App resource with full configuration support:
 * health probes, CORS, custom domains, secret volumes (files), registries.
 */
export class ContainerAppDeployer extends AzureDeployer<ContainerAppDeployParams> {
  deploy(spec: ContainerAppSpec): DeployedContainerApp {
    // Build secrets from secretEnv + registry passwords
    const secrets: pulumi.Input<inputs.app.SecretArgs>[] = []

    if (spec.secretEnv) {
      for (const [name, value] of Object.entries(spec.secretEnv)) {
        secrets.push({ name: toSecretName(name), value })
      }
    }

    // File contents as secrets
    const fileSecrets: { secretName: string; fileName: string }[] = []
    if (spec.files && spec.files.length > 0) {
      for (const file of spec.files) {
        const secretName = `file-${toSecretName(file.path)}`
        secrets.push({ name: secretName, value: file.content })
        fileSecrets.push({
          secretName,
          fileName: file.path.split('/').pop() ?? file.path,
        })
      }
    }

    // Registry password secrets
    const registries: pulumi.Input<inputs.app.RegistryCredentialsArgs>[] = []
    for (const reg of this.params.registries ?? []) {
      registries.push({
        server: reg.server,
        username: reg.username,
        passwordSecretRef: reg.passwordSecretRef,
        identity: reg.identity,
      })
    }

    // Build env vars
    const envVars: inputs.app.EnvironmentVarArgs[] = []
    if (spec.env) {
      for (const [name, value] of Object.entries(spec.env)) {
        if (value !== undefined) {
          envVars.push({ name, value })
        }
      }
    }
    if (spec.secretEnv) {
      for (const name of Object.keys(spec.secretEnv)) {
        envVars.push({ name, secretRef: toSecretName(name) })
      }
    }

    // Build volumes
    const volumes: inputs.app.VolumeArgs[] = (spec.volumes ?? []).map((v) => ({
      name: v.name,
      storageType: v.storageType,
      storageName: v.storageName,
    }))

    const volumeMounts: inputs.app.VolumeMountArgs[] = (spec.volumes ?? []).map((v) => ({
      volumeName: v.name,
      mountPath: v.mountPath,
    }))

    // Files — mounted as ACA secret volumes grouped by parent directory.
    if (fileSecrets.length > 0 && spec.files) {
      const filesByDir = new Map<string, { secretName: string; fileName: string }[]>()
      for (let i = 0; i < spec.files.length; i++) {
        const file = spec.files[i]
        const dir = file.path.substring(0, file.path.lastIndexOf('/')) || '/'
        const fileName = file.path.split('/').pop() ?? 'file'
        if (!filesByDir.has(dir)) filesByDir.set(dir, [])
        filesByDir.get(dir)!.push({
          secretName: fileSecrets[i].secretName,
          fileName,
        })
      }

      let volIdx = 0
      for (const [dir, dirFiles] of filesByDir) {
        const volName = `files-${volIdx++}`
        volumes.push({
          name: volName,
          storageType: 'Secret',
          secrets: dirFiles.map((f) => ({
            secretRef: f.secretName,
            path: f.fileName,
          })),
        })
        volumeMounts.push({
          volumeName: volName,
          mountPath: dir,
        })
      }
    }

    // Build probes
    const probes: inputs.app.ContainerAppProbeArgs[] = (spec.probes ?? []).map((p) => ({
      type: p.type,
      httpGet: p.httpGet ? { path: p.httpGet.path, port: p.httpGet.port } : undefined,
      tcpSocket: p.tcpSocket ? { port: p.tcpSocket.port } : undefined,
      initialDelaySeconds: p.initialDelaySeconds,
      periodSeconds: p.periodSeconds,
      timeoutSeconds: p.timeoutSeconds,
      failureThreshold: p.failureThreshold,
      successThreshold: p.successThreshold,
    }))

    // Build ingress
    let ingress: inputs.app.IngressArgs | undefined
    if (spec.targetPort) {
      ingress = {
        targetPort: spec.targetPort,
        external: spec.external ?? false,
        transport: spec.transport ?? 'auto',
        allowInsecure: spec.allowInsecure ?? false,
        corsPolicy: spec.corsPolicy
          ? {
              allowedOrigins: spec.corsPolicy.allowedOrigins,
              allowedMethods: spec.corsPolicy.allowedMethods,
              allowedHeaders: spec.corsPolicy.allowedHeaders,
              allowCredentials: spec.corsPolicy.allowCredentials,
              maxAge: spec.corsPolicy.maxAge,
            }
          : undefined,
        customDomains: spec.customDomains?.map((d) => ({
          name: d.name,
          certificateId: d.certificateId,
          bindingType: d.certificateId ? 'SniEnabled' : 'Disabled',
        })),
      }
    }

    const containerApp = new app.ContainerApp(
      spec.name,
      {
        containerAppName: spec.name,
        resourceGroupName: this.resourceGroupName,
        environmentId: this.params.environmentId,
        location: this.location,
        ...(spec.workloadProfileName ? { workloadProfileType: spec.workloadProfileName } : {}),
        configuration: {
          ingress,
          registries: registries.length > 0 ? registries : undefined,
          secrets: secrets.length > 0 ? secrets : undefined,
        },
        template: {
          containers: [
            {
              name: spec.name,
              image: spec.image,
              command: spec.command,
              env: envVars.length > 0 ? envVars : undefined,
              resources: {
                cpu: spec.cpuCores ?? 0.25,
                memory: `${spec.memoryGi ?? 0.5}Gi`,
              },
              volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined,
              probes: probes.length > 0 ? probes : undefined,
            },
          ],
          scale: {
            minReplicas: spec.minReplicas ?? 0,
            maxReplicas: spec.maxReplicas ?? 1,
          },
          volumes: volumes.length > 0 ? volumes : undefined,
        },
      },
      this.options(),
    )

    const fqdn = containerApp.configuration.apply((cfg) => cfg?.ingress?.fqdn ?? '')

    return { app: containerApp, fqdn }
  }
}

/** Convert a variable name to a valid ACA secret name (lowercase, alphanumeric, dashes) */
function toSecretName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

/** @deprecated Use ContainerAppDeployParams instead */
export type ContainerAppDeployerArgs = ContainerAppDeployParams
