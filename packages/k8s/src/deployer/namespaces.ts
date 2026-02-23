import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as _ from 'lodash'
import { KubernetesDeployer } from './base'

export class NamespacesDeployer extends KubernetesDeployer {
  public deploy<T extends string>(args: NamespacesArgs<T>): Record<T, pulumi.Output<string>> {
    const output: Partial<Record<T, pulumi.Output<string>>> = {}
    for (const key of _.keys(args.namespaces)) {
      const metadata: any = {}
      if (!args.autoName) metadata.name = args.namespaces[key as T]

      output[key as T] = (
        NamespacesCache.cache[args.namespaces[key as T]] ??
        (NamespacesCache.cache[args.namespaces[key as T]] = new k8s.core.v1.Namespace(
          args.namespaces[key as T],
          {
            metadata: metadata,
          },
          this.options(),
        ))
      ).metadata.name
    }
    return output as Record<T, pulumi.Output<string>>
  }
}

class NamespacesCache {
  public static cache: Record<string, k8s.core.v1.Namespace> = {}
}

export interface NamespacesArgs<TNamespaces extends string> {
  namespaces: Record<TNamespaces, string>
  autoName?: boolean
}
