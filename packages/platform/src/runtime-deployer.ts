import * as pulumi from '@pulumi/pulumi'
import { WorkloadRuntime } from './runtime'
import { DeployedWorkload, Workload, WorkloadMetadata } from './workload'

/**
 * Bridge between the generic platform and runtime-specific deployers.
 *
 * Each runtime (K8s, Docker, Azure Container Apps) implements this interface
 * to translate a runtime-agnostic Workload into concrete infrastructure.
 */
export interface RuntimeDeployer<TRuntime extends WorkloadRuntime = WorkloadRuntime> {
  readonly runtimeKind: string

  deploy(workload: Workload<TRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload>
}
