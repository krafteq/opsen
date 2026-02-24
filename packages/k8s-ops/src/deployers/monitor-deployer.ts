import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { KubernetesDeployer } from '@opsen/k8s'

export class MonitorDeployer extends KubernetesDeployer {
  public deploy(args: MonitorArgs): DeployedMonitor {
    pulumi.output(args.namespaces).apply((namespaces) =>
      namespaces.map((ns) => {
        return new k8s.apiextensions.CustomResource(
          `${args.name}-${ns}`,
          {
            apiVersion: 'monitoring.coreos.com/v1',
            kind: 'PodMonitor',
            metadata: {
              name: `${ns}-pod-monitor`,
              namespace: ns,
            },
            labels: {
              name: 'pod-monitor',
            },
            spec: {
              podTargetLabels: args.targetLabels,
              selector: {
                matchLabels: {
                  monitoring: 'true',
                },
              },
              podMetricsEndpoints: [
                {
                  port: 'http-metrics',
                  path: '/metrics',
                },
              ],
            },
          },
          this.options(),
        )
      }),
    )
    return {}
  }
}

export interface DeployedMonitor {}

export interface MonitorArgs {
  name: string
  namespaces: pulumi.Input<pulumi.Input<string>[]>
  targetLabels?: string[]
}
