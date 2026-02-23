import { InfrastructureFact } from '@opsen/infra'
import { DeployedWorkload } from '../workload'

export type WorkloadFact = InfrastructureFact<
  'Workload',
  {
    workload: DeployedWorkload
  },
  string
>
