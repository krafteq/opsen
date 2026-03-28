import { InfrastructureFact } from './fact'
import * as pulumi from '@pulumi/pulumi'
import { InfrastructureConfigMerger } from './config-merger'
import { InfrastructureConfigReader } from './config-reader'
import { InfrastructureFactsPool } from './facts-pool'
import { InfrastructureConfig } from './config'
import { InfrastructureModule } from './module'
import { FactsApi } from './facts-api'
import type { FactStoreReader, FactStoreWriter } from './fact-store'

export abstract class InfrastructureDeployer<
  TFactApi extends FactsApi,
  TArgs extends InfrastructureDeployerArgs = InfrastructureDeployerArgs,
> {
  protected readonly args: TArgs
  protected readonly configs: pulumi.Output<InfrastructureConfig[]>

  private readonly discoveredFacts: InfrastructureFact[] = []
  public readonly owner: string

  protected _facts: pulumi.Output<TFactApi>

  public constructor(args: TArgs) {
    this.args = args
    this.owner = `${pulumi.getOrganization()}/${pulumi.getProject()}/${pulumi.getStack()}`

    const stackConfigs = new InfrastructureConfigReader(this.args.configStacks ?? []).read()

    const storeConfigs = this.args.factSources?.length
      ? pulumi.output(
          Promise.all(this.args.factSources.map((s) => s.read())).then((configs) =>
            configs.map((c) => c ?? { facts: [] }),
          ),
        )
      : pulumi.output([] as InfrastructureConfig[])

    this.configs = pulumi.all([stackConfigs, storeConfigs]).apply(([a, b]) => [...a, ...b])
    this._facts = this.rebuildFacts(undefined)
  }

  public deploy(...deployable: Deployable<TFactApi>[]): pulumi.Output<InfrastructureConfig> {
    if (deployable.length === 0) {
      return pulumi.output({ facts: [] })
    }

    const deployRec = (idx: number): pulumi.Output<InfrastructureConfig> => {
      return this.deploySingle(deployable[idx]).apply((res) => {
        if (idx + 1 >= deployable.length) {
          return pulumi.output(res)
        }

        return deployRec(idx + 1)
      })
    }

    return deployRec(0).apply((finalConfig) => {
      if (this.args.factSink && !pulumi.runtime.isDryRun()) {
        return pulumi.output(this.args.factSink.write(finalConfig).then(() => finalConfig))
      }
      return pulumi.output(finalConfig)
    })
  }

  private deploySingle(deployable: Deployable<TFactApi>): pulumi.Output<InfrastructureConfig> {
    const func =
      typeof deployable === 'function' ? deployable : (ctx: InfrastructureContext<TFactApi>) => deployable.script(ctx)
    const exposedFacts: pulumi.Input<InfrastructureFact>[] = []
    let currentFacts: TFactApi | undefined = undefined

    const result = this._facts.apply((f) => {
      currentFacts = f
      return func({
        facts: f,
        expose: (...facts: FactWithoutOwner<TFactApi>[]) => {
          for (const fact of facts) {
            if (fact.hasOwnProperty('owner')) {
              if (this.discoveredFacts.find((x) => x.kind === fact.kind && x.metadata.name === fact.metadata.name)) {
                continue
              }

              exposedFacts.push(<any>fact)
            } else {
              exposedFacts.push({ owner: this.owner, ...fact })
            }
          }
        },
      })
    })

    return result.apply(() => {
      return pulumi.all(exposedFacts).apply((x) => {
        this.discoveredFacts.push(...x.map((f) => (f.owner ? f : { ...f, owner: this.owner })))
        this._facts = this.rebuildFacts(currentFacts)
        return pulumi.secret({
          facts: [...this.discoveredFacts],
        })
      })
    })
  }

  protected abstract createFactsApi(facts: InfrastructureFactsPool): TFactApi

  private rebuildFacts(currentFacts: TFactApi | undefined): pulumi.Output<TFactApi> {
    const newFacts = this.discoveredFacts.filter(
      (fact) => currentFacts === undefined || currentFacts.pool.getFact(fact.kind, fact.metadata.name) === undefined,
    )
    return this.configs
      .apply((x) => new InfrastructureFactsPool(InfrastructureConfigMerger.merge(...x, { facts: newFacts })))
      .apply((x) => this.createFactsApi(x))
  }
}

export interface InfrastructureDeployerArgs {
  /** @deprecated Use factSources with PulumiFactStore instead */
  configStacks?: pulumi.Input<pulumi.Input<string>[]>
  factSources?: FactStoreReader[]
  factSink?: FactStoreWriter
}

type FactType<TFactApi> = TFactApi extends FactsApi<infer TFact> ? TFact : never

type FactWithoutOwner<TFactApi> = Omit<FactType<TFactApi>, 'owner'>

export interface InfrastructureContext<TFactApi extends FactsApi> {
  facts: TFactApi
  expose(...fact: FactWithoutOwner<TFactApi>[]): void
}

export type Deployable<T extends FactsApi> =
  | InfrastructureModule<T>
  | ((ctx: InfrastructureContext<T>) => void | pulumi.Output<void>)
