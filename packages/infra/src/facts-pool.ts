import { InfrastructureFact, InfrastructureFactLabelValue } from './fact'
import { InfrastructureConfig } from './config'

export class InfrastructureFactsPool<TFacts extends InfrastructureFact = InfrastructureFact> {
  private readonly factsMap: Map<string, TFacts> = new Map<string, TFacts>()
  private readonly factsByKindMap: Map<string, TFacts[]> = new Map<string, TFacts[]>()

  public constructor(private readonly config: InfrastructureConfig) {
    for (const fact of this.config.facts) {
      const key = this.buildKey(fact.kind, fact.metadata.name)
      if (this.factsMap.has(key)) {
        throw new Error(`Fact ${fact.kind} ${fact.metadata.name} already exists`)
      }

      this.factsMap.set(key, fact as TFacts)

      let kindGroup = this.factsByKindMap.get(fact.kind)
      if (!kindGroup) {
        this.factsByKindMap.set(fact.kind, (kindGroup = []))
      }

      kindGroup.push(fact as TFacts)
    }
  }

  public requireFact<T extends TFacts = TFacts>(kind: T['kind'], name: string): T {
    const fact = this.getFact(kind, name)
    if (!fact) {
      throw new Error(`Required Fact ${kind}#${name} not found`)
    }
    return fact
  }

  public getFact<T extends TFacts = TFacts>(kind: T['kind'], name: string): T | undefined {
    return this.factsMap.get(this.buildKey(kind, name)) as T | undefined
  }

  public getAll<T extends TFacts = TFacts>(kind: T['kind']): T[] {
    const facts = this.factsByKindMap.get(kind)
    if (!facts) {
      return []
    }
    return facts as T[]
  }

  public matchByLabels<T extends TFacts = TFacts>(
    kind: T['kind'],
    labels: Record<keyof T['metadata']['labels'], InfrastructureFactLabelValue>,
  ): T[] {
    const facts = this.factsByKindMap.get(kind)
    if (!facts) {
      return []
    }

    return facts.filter((x) => this.matches(x, labels)) as T[]
  }

  private matches(fact: TFacts, labels: Record<string, InfrastructureFactLabelValue>): boolean {
    for (const [key, value] of Object.entries(labels)) {
      const factLabelValue = fact.metadata.labels?.[key]
      if (factLabelValue === undefined) {
        return false
      }

      // label exists, no value is required
      if (!value) {
        return true
      }

      return factLabelValue === value
    }

    return false
  }

  private buildKey(kind: string, name: string): string {
    return `${kind}#${name}`
  }
}
