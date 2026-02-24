import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import {
  ImageRegistryArgs,
  ImageRegistryInfo,
  ImageRegistrySecret,
  DeployedImagePullSecrets,
} from '../deployer/image-registry'

const secretsCache: Record<string, k8s.core.v1.Secret> = {}

/**
 * Deploy Kubernetes image-pull secrets for one or more container registries
 * across one or more namespaces.
 */
export function deployK8sImagePullSecrets(
  registries: ImageRegistryArgs['registries'],
  namespaces: ImageRegistryArgs['namespaces'],
  opts?: pulumi.CustomResourceOptions,
): DeployedImagePullSecrets {
  const secrets = pulumi.all([registries, namespaces]).apply(([registries, namespaces]) => {
    const result: pulumi.Output<ImageRegistrySecret>[] = []
    for (const [registryKey, registry] of Object.entries(registries)) {
      const dockerconfigjson = toDockerConfigJsonString(registry)
      if (!dockerconfigjson) throw new Error(`Invalid image registry input for ${registryKey}`)

      for (const [nsKey, ns] of Object.entries(namespaces)) {
        const secretName = `pull-secret-${nsKey.toLowerCase()}-${registryKey.toLowerCase()}`
        const secret =
          secretsCache[secretName] ??
          (secretsCache[secretName] = new k8s.core.v1.Secret(
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
            opts,
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

  return { secrets }
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
