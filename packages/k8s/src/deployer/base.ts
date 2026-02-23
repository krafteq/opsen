/// <reference path="../global.d.ts" />
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as _ from 'lodash'
import { ComputeResources, StorageClassRequest, StorageClassMeta, ResourceRequirements } from '@opsen/platform'

export interface KubernetesDeployParams {
  name: string
  kubeconfig: pulumi.Input<string>
  storageClasses?: pulumi.Input<pulumi.Input<StorageClassMeta>[]>
}

if (!global.PROVIDERS_LOOKUP) global.PROVIDERS_LOOKUP = {}

export class KubernetesDeployer<TParams extends KubernetesDeployParams = KubernetesDeployParams> {
  protected readonly provider: k8s.Provider
  protected readonly name: string
  protected readonly storageClasses: pulumi.Output<StorageClassMeta[]>

  public constructor(protected readonly params: TParams) {
    this.name = params.name
    this.storageClasses = params.storageClasses
      ? pulumi.output(params.storageClasses).apply((x) => pulumi.all(x))
      : pulumi.output([])

    this.provider =
      PROVIDERS_LOOKUP[params.name] ??
      (PROVIDERS_LOOKUP[params.name] = new k8s.Provider(params.name, {
        kubeconfig: params.kubeconfig,
        kubeClientSettings: {
          burst: 10000,
          qps: 200,
        },
      }))
  }

  protected options(opts?: pulumi.CustomResourceOptions): pulumi.CustomResourceOptions {
    const result = opts ? _.clone(opts) : {}

    if (!result.provider) result.provider = this.provider

    if (result.dependsOn)
      result.dependsOn = pulumi
        .output(result.dependsOn)
        .apply((x) => (Array.isArray(x) ? [...x, this.provider] : [x, this.provider]))
    else result.dependsOn = this.provider

    return result
  }

  protected getResourceRequirements(req: ComputeResources): ResourceRequirements {
    const [cpu, memory] = typeof req == 'string' ? req.split(',') : [req.cpu, req.memory]

    return {
      requests: {
        cpu: cpu.split('/')[0],
        memory: memory.split('/')[0],
      },
      limits: {
        cpu: cpu.split('/')[1],
        memory: memory.split('/')[1],
      },
    }
  }

  protected storageClass(
    request: StorageClassRequest,
    opts?: { failIfNoMatch: boolean },
  ): pulumi.Output<string | undefined> {
    if (typeof request == 'string') return pulumi.output(request)

    return this.storageClasses.apply((all) => {
      const match = all.filter((x) => {
        for (const item of _.entries(request)) {
          if (x.labels[item[0]] != item[1]) return false
        }

        return true
      })

      if (match.length == 0 && opts?.failIfNoMatch == true)
        throw new Error(`storage class for ${JSON.stringify(request)} not found`)

      return match[0]?.name
    })
  }
}
