import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { HelmOverride } from '@opsen/platform'

export interface ExternalDnsArgs {
  namespace?: pulumi.Input<string>
  helmOverride?: pulumi.Input<HelmOverride>
  provider: pulumi.Input<DnsProvider>
}

export type DnsProvider = CloudflareProvider

export interface CloudflareProvider {
  type: 'cloudflare'
  apiToken: pulumi.Input<string>
}

export class ExternalDns extends pulumi.ComponentResource {
  public constructor(name: string, args: ExternalDnsArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:ExternalDns', name, args, opts)

    const helmOverride = pulumi.output(args.helmOverride)
    const meta = pulumi.output({
      chart: 'external-dns',
      version: helmOverride.apply((x) => x?.version ?? '1.16.1'),
      repo: 'https://kubernetes-sigs.github.io/external-dns/',
    })

    const apiTokenSecret = new k8s.core.v1.Secret(
      `${name}-provider-secret`,
      {
        metadata: {
          namespace: args.namespace,
        },
        type: 'Opaque',
        stringData: {
          'api-token': pulumi.output(args.provider).apiToken,
        },
      },
      { parent: this },
    )

    new k8s.helm.v4.Chart(
      name,
      {
        namespace: args.namespace,
        chart: meta.chart,
        version: meta.version,
        repositoryOpts: {
          repo: meta.repo,
        },
        values: helmOverride.apply((x) => ({
          provider: {
            name: pulumi.output(args.provider).type,
          },
          env: [
            {
              name: 'CF_API_TOKEN',
              valueFrom: {
                secretKeyRef: {
                  name: apiTokenSecret.metadata.name,
                  key: 'api-token',
                },
              },
            },
          ],
          ...x?.values,
        })),
      },
      { parent: this },
    )
  }
}
