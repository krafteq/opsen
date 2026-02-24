import { InfrastructureFact } from './fact'
import { InfrastructureFactsPool } from './facts-pool'

export interface FactsApi<TFacts extends InfrastructureFact = InfrastructureFact> {
  pool: InfrastructureFactsPool<TFacts>
}
