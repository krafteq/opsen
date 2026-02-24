import type { InfrastructureConfig } from './config'
import type { FactStoreReader } from './fact-store'
import { StackReference } from './stack-reference'

export class PulumiFactStore implements FactStoreReader {
  constructor(private readonly stackName: string) {}

  read(): Promise<InfrastructureConfig> {
    return new Promise<InfrastructureConfig>((resolve) => {
      StackReference.get(this.stackName)
        .getOutput('config')
        .apply((config) => {
          resolve((config as InfrastructureConfig) ?? { facts: [] })
        })
    })
  }
}
