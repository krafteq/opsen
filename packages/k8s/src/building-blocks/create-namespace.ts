import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

const namespaceCache: Record<string, k8s.core.v1.Namespace> = {}

/**
 * Create (or reuse) a Kubernetes namespace.
 *
 * Namespaces are deduplicated by name — calling this function twice with the
 * same name returns the same resource.
 */
export function createK8sNamespace(name: string, opts?: pulumi.CustomResourceOptions): pulumi.Output<string> {
  const ns =
    namespaceCache[name] ??
    (namespaceCache[name] = new k8s.core.v1.Namespace(
      name,
      {
        metadata: { name },
      },
      opts,
    ))

  return ns.metadata.name
}
