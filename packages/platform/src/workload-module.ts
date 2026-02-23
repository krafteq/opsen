import * as pulumi from '@pulumi/pulumi'
import { FactsApi, InfrastructureContext, InfrastructureModule } from '@opsen/infra'
import { WorkloadRuntime } from './runtime'
import { Workload, WorkloadMetadata } from './workload'
import { RuntimeDeployer } from './runtime-deployer'

/**
 * Generic infrastructure module that wraps any RuntimeDeployer into
 * an InfrastructureModule. Replaces the runtime-specific modules
 * (e.g. KubernetesWorkloadModule) with a single runtime-agnostic module.
 */
export class WorkloadModule<
  TFactsApi extends FactsApi,
  TRuntime extends WorkloadRuntime,
> implements InfrastructureModule<TFactsApi> {
  constructor(
    private readonly deployer: RuntimeDeployer<TRuntime>,
    private readonly metadata: WorkloadMetadata,
    private readonly workload: Workload<TRuntime>,
  ) {}

  script(ctx: InfrastructureContext<TFactsApi>): pulumi.Output<void> {
    return this.deployer.deploy(this.workload, this.metadata).apply((result) => {
      ctx.expose({
        kind: 'Workload',
        metadata: { name: this.metadata.name },
        spec: { workload: result },
      } as any)
    })
  }
}
