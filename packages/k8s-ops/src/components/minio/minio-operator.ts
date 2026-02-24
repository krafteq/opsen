import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { Certificate } from '../cert-manager/certificate'

export interface MinioOperatorArgs {
  namespace: pulumi.Input<string>
  nodeSelector?: pulumi.Input<Record<string, string>>
  version?: pulumi.Input<string>
  ingress?: {
    consoleHost: string
    consolePath?: string
    certificateIssuer: string
  }
}

export class MinioOperator extends pulumi.ComponentResource {
  public readonly publicHost?: string

  public constructor(name: string, args: MinioOperatorArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:MinioOperator', name, args, opts)

    const ingressValues: any = {
      enabled: false,
    }

    if (args.ingress?.consoleHost) {
      this.publicHost = args.ingress.consoleHost

      const certificate = new Certificate(
        `${name}-cert`,
        {
          namespace: args.namespace,
          domain: args.ingress.consoleHost,
          issuer: args.ingress.certificateIssuer,
        },
        { parent: this },
      )

      ingressValues.enabled = true
      ingressValues.ingressClassName = 'nginx'
      ingressValues.tls = [
        {
          hots: [args.ingress.consoleHost],
          secretName: certificate.secretName,
        },
      ]
      ingressValues.host = args.ingress.consoleHost
      ingressValues.path = args.ingress.consolePath || '/'
    }

    new k8s.helm.v3.Release(
      name,
      {
        repositoryOpts: {
          repo: 'https://operator.min.io/',
        },
        chart: 'operator',
        version: args.version ?? '4.5.0',
        namespace: args.namespace,
        values: {
          operator: {
            nodeSelector: args.nodeSelector,
          },
          console: {
            ingress: ingressValues,
          },
        },
      },
      { parent: this },
    )

    this.registerOutputs()
  }
}
