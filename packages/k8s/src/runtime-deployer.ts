import * as pulumi from '@pulumi/pulumi'
import {
  RuntimeDeployer,
  KubernetesRuntime,
  Workload,
  WorkloadMetadata,
  DeployedWorkload,
  StorageClassMeta,
} from '@opsen/platform'
import { KubernetesDeployParams, NamespacesDeployer, ImageRegistryDeployer, ImageRegistrySecret } from './deployer'
import { WorkloadDeployer, IngressInfo } from './workload/workload-deployer'

export interface K8sRuntimeDeployerArgs {
  /** Unique name for this K8s provider (used for Pulumi resource naming) */
  name: string
  kubeconfig: pulumi.Input<string>
  namespace: string
  storageClasses?: pulumi.Input<pulumi.Input<StorageClassMeta>[]>
  ingress?: IngressInfo[]
  certIssuer?: string
  registries?: Record<string, K8sContainerRegistry>
}

export interface K8sContainerRegistry {
  host: string
  auth?: { user: string; password: string }
}

/**
 * Kubernetes RuntimeDeployer. Orchestrates namespace creation, image registry
 * secrets, and workload deployment via the WorkloadDeployer.
 *
 * This extracts the logic previously in KubernetesWorkloadModule into a
 * standalone class that doesn't depend on Krafteq-specific facts.
 */
export class K8sRuntimeDeployer implements RuntimeDeployer<KubernetesRuntime> {
  readonly runtimeKind = 'k8s'

  constructor(private readonly args: K8sRuntimeDeployerArgs) {}

  deploy(workload: Workload<KubernetesRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload> {
    const deployParams: KubernetesDeployParams = {
      name: this.args.name,
      kubeconfig: this.args.kubeconfig,
      storageClasses: this.args.storageClasses,
    }

    const nsDeployer = new NamespacesDeployer(deployParams)
    const ns = nsDeployer.deploy({
      namespaces: { workloads: this.args.namespace },
      autoName: false,
    })

    let secrets: pulumi.Input<ImageRegistrySecret[]> | undefined
    const registries = this.args.registries ?? {}
    if (Object.entries(registries).length > 0) {
      const imageRegistrySecretsDeployer = new ImageRegistryDeployer(deployParams)
      const deployedSecrets = imageRegistrySecretsDeployer.deploy({
        namespaces: ns,
        registries: Object.fromEntries(
          Object.entries(registries).map(([name, registry]) => [
            name,
            {
              ...(registry.auth
                ? {
                    auths: {
                      [registry.host]: { auth: { ...registry.auth } },
                    },
                  }
                : undefined),
            },
          ]),
        ),
      })

      secrets = deployedSecrets.secrets
    }

    const ingress = (this.args.ingress ?? []).map((x) => ({
      ...x,
      certIssuer: this.args.certIssuer,
    }))

    const workloadDeployer = new WorkloadDeployer({
      ...deployParams,
      namespace: ns.workloads,
      nodeSelectors: undefined,
      imageRegistrySecrets: secrets,
      ingress,
    })

    return workloadDeployer.deploy(workload, metadata)
  }
}
