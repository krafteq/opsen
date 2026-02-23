import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import { KubernetesDeployer } from './base'

export class ImageRegistryDeployer extends KubernetesDeployer {
  public deploy(args: ImageRegistryArgs): DeployedImagePullSecrets {
    const secrets = pulumi.all([args.registries, args.namespaces]).apply(([registries, namespaces]) => {
      const result: pulumi.Output<ImageRegistrySecret>[] = []
      for (const [registryKey, registry] of Object.entries(registries)) {
        const dockerconfigjson = toDockerConfigJsonString(registry)
        if (!dockerconfigjson) throw new Error(`Invalid image registry input for ${registryKey}`)

        for (const [nsKey, ns] of Object.entries(namespaces)) {
          const secretName = `pull-secret-${nsKey.toLowerCase()}-${registryKey.toLowerCase()}`
          const secret =
            SecretsCache.cache[secretName] ??
            (SecretsCache.cache[secretName] = new k8s.core.v1.Secret(
              secretName,
              {
                metadata: {
                  namespace: ns,
                },
                data: {
                  '.dockerconfigjson': dockerconfigjson,
                },
                type: 'kubernetes.io/dockerconfigjson',
              },
              this.options(),
            ))

          result.push(
            secret.metadata.name.apply((name) => {
              return {
                namespace: ns,
                registry: registryKey,
                secretName: name,
                hosts: typeof registry == 'string' || !registry.auths ? [] : Object.keys(registry.auths),
              }
            }),
          )
        }
      }
      return pulumi.all(result)
    })

    return {
      secrets: secrets,
    }
  }
}

class SecretsCache {
  public static cache: Record<string, k8s.core.v1.Secret> = {}
}

export interface DeployedImagePullSecrets {
  secrets: pulumi.Output<ImageRegistrySecret[]>
}

export interface ImageRegistrySecret {
  namespace: string
  registry: string
  hosts: string[]
  secretName: string
}

export interface ImageRegistryArgs {
  registries: pulumi.Input<Record<string, pulumi.Input<ImageRegistryInfo | string>>>
  namespaces: pulumi.Input<Record<string, pulumi.Input<string>>>
}

export interface ImageRegistryInfo {
  auths?: pulumi.Input<Record<string, pulumi.Input<ImageRegistryAuth>>>
}

export interface ImageRegistryAuth {
  auth:
    | pulumi.Input<{
        user: pulumi.Input<string>
        password: pulumi.Input<string>
      }>
    | pulumi.Input<string>
  email?: pulumi.Input<string>
}

function toDockerConfigJsonString(
  dockerRegistry: pulumi.UnwrappedObject<ImageRegistryInfo> | string,
): string | undefined {
  if (typeof dockerRegistry == 'string') return dockerRegistry

  if (dockerRegistry.auths == undefined) return undefined

  const encodedAuths: any = {}

  for (const [registry, auth] of Object.entries(dockerRegistry.auths)) {
    encodedAuths[registry] = {
      email: auth.email ?? '',
      auth:
        typeof auth.auth == 'string'
          ? auth.auth
          : Buffer.from(`${auth.auth.user}:${auth.auth.password}`).toString('base64'),
    }
  }

  return Buffer.from(
    JSON.stringify(
      {
        auths: encodedAuths,
      },
      null,
      2,
    ),
  ).toString('base64')
}
