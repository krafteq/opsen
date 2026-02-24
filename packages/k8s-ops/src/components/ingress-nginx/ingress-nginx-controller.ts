import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { HelmOverride } from '@opsen/platform'

export interface IngressNginxControllerArgs {
  namespace?: pulumi.Input<string>
  helmOverride?: pulumi.Input<HelmOverride>
  default?: pulumi.Input<boolean>
  ingressClass?: pulumi.Input<string> /* default nginx */
  service?: {
    annotations?: pulumi.Input<Record<string, pulumi.Input<string>>>
  }
}

export class IngressNginxController extends pulumi.ComponentResource {
  public readonly publicIP?: pulumi.Output<string>

  public constructor(name: string, args: IngressNginxControllerArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:IngressNginxController', name, args, {
      ...opts,
      aliases: [...(opts?.aliases ?? []), { type: 'opsen-k8s:IngressNginxController' }],
    })

    const helmOverride = pulumi.output(args.helmOverride)
    const meta = pulumi.output({
      chart: 'ingress-nginx',
      version: helmOverride.apply((x) => x?.version ?? '4.12.0'),
      repo: 'https://kubernetes.github.io/ingress-nginx',
    })

    const ingressClass = pulumi.output(args.ingressClass).apply((x) => x ?? 'nginx')
    const service = pulumi.output(args.service)
    const isDefault = pulumi.output(args.default)

    const chart = new k8s.helm.v3.Chart(
      name,
      {
        namespace: args.namespace,
        chart: meta.chart,
        version: meta.version,
        fetchOpts: {
          repo: meta.repo,
        },
        values: helmOverride.apply((x) => ({
          controller: {
            electionID: pulumi.interpolate`ingress-${ingressClass}-leader`,
            ingressClass: ingressClass,
            ingressClassResource: {
              name: ingressClass,
              enabled: true,
              default: isDefault,
              controllerValue: pulumi.interpolate`k8s.io/ingress-${ingressClass}`,
            },
            service: {
              annotations: service.apply((x) => x?.annotations),
            },
            metrics: {
              enabled: true,
              service: {
                labels: {
                  name: 'nginx-controller',
                },
              },
            },
            enableLatencyMetrics: true,
            publishService: {
              enabled: true,
            },
            admissionWebhooks: {
              enabled: false,
            },
          },
          ...x?.values,
        })),
      },
      { parent: this },
    )

    const frontend = pulumi
      .output({ ns: args.namespace, ingressClass })
      .apply((x) =>
        chart.getResourceProperty('v1/Service', x.ns ?? 'default', `${name}-ingress-nginx-controller`, 'status'),
      )

    const ingress = frontend.apply((x) => x.loadBalancer.ingress[0])
    this.publicIP = ingress.apply((x) => x.ip ?? x.hostname)
  }
}
