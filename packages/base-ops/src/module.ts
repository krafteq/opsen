import { InfrastructureContext } from './deployer'
import * as pulumi from '@pulumi/pulumi'
import { FactsApi } from './facts-api'

export interface InfrastructureModule<TFactsApi extends FactsApi> {
  script(ctx: InfrastructureContext<TFactsApi>): void | pulumi.Output<void>
}
