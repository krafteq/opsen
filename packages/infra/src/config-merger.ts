import { InfrastructureConfig } from './config'

export class InfrastructureConfigMerger {
  public static merge(...configs: InfrastructureConfig[]): InfrastructureConfig {
    const result: InfrastructureConfig = {
      facts: [],
    }

    for (const config of configs) {
      result.facts.push(...config.facts)
    }

    return result
  }
}
