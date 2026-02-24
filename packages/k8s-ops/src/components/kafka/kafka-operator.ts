import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'

export interface KafkaOperatorArgs {
  namespace: pulumi.Input<string>
  watchNamespaces: pulumi.Input<string[]>
  nodeSelector?: pulumi.Input<Record<string, string>>
  watchAnyNamespace: boolean
  version?: pulumi.Input<string>
}

export class KafkaOperator extends pulumi.ComponentResource {
  public readonly chart: k8s.helm.v3.Release

  public constructor(name: string, args: KafkaOperatorArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:KafkaOperator', name, args, {
      ...opts,
      aliases: [...(opts?.aliases ?? []), { type: 'opsen-k8s:KafkaOperator' }],
    })

    const values = pulumi.Output.create(args.watchNamespaces).apply((namespaces) => {
      return {
        watchNamespaces: namespaces,
        watchAnyNamespace: args.watchAnyNamespace,
        nodeSelector: args.nodeSelector,
      }
    })

    this.chart = new k8s.helm.v3.Release(
      name,
      {
        repositoryOpts: {
          repo: 'https://strimzi.io/charts',
        },
        chart: 'strimzi-kafka-operator',
        version: args.version ?? '0.32.0',
        namespace: args.namespace,
        values: values,
      },
      { parent: this },
    )

    this.registerOutputs()
  }
}
