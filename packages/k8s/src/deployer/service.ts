import * as pulumi from '@pulumi/pulumi'
import { KubernetesDeployParams, KubernetesDeployer } from './base'
import { ImageRegistrySecret } from './image-registry'
import { strict as assert } from 'assert'

export interface ServiceDeployParams extends KubernetesDeployParams {
  namespace: pulumi.Input<string>
  nodeSelectors?: pulumi.Input<Record<string, string>>
  imageRegistrySecrets?: pulumi.Input<ImageRegistrySecret[]>
}

export class KubernetesServiceDeployer<
  TParams extends ServiceDeployParams = ServiceDeployParams,
> extends KubernetesDeployer<TParams> {
  protected readonly namespace: pulumi.Input<string>
  protected readonly nodeSelectors?: pulumi.Input<Record<string, string>>
  protected readonly imageRegistrySecrets?: pulumi.Input<ImageRegistrySecret[]>

  public constructor(params: TParams) {
    super(params)

    assert(params.namespace)
    this.namespace = params.namespace
    this.nodeSelectors = params.nodeSelectors
    this.imageRegistrySecrets = params.imageRegistrySecrets
  }

  protected imagePullSecrets(opts?: {
    image?: pulumi.Input<string>
    registry?: pulumi.Input<string>
  }): pulumi.Output<{ name: string }[]> {
    if (!this.imageRegistrySecrets) {
      if (opts?.registry) throw new Error('no image registry secrets provided')

      return pulumi.output([])
    }

    const imageHost = opts?.image ? pulumi.output(opts.image).apply(getImageHost) : undefined

    return pulumi
      .all([pulumi.output(this.imageRegistrySecrets), pulumi.output(this.namespace), imageHost])
      .apply(([s, namespace, imageHost]) => {
        let filteredSecrets = s.filter((x) => x.namespace == namespace)

        if (opts?.registry) filteredSecrets = filteredSecrets.filter((x) => x.registry == opts.registry)

        if (imageHost) filteredSecrets = filteredSecrets.filter((x) => x.hosts.includes(imageHost))

        return filteredSecrets.map((x) => ({ name: x.secretName }))
      })
  }
}

function getImageHost(image: string): string | undefined {
  const segments = image.split('/')
  if (segments[0]?.includes('.')) return segments[0]
  return undefined
}
