import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { HelmOverride, Ingress } from '@opsen/platform'
import { HelmHelpers } from '../helpers/helm-helpers'

export interface OAuthArgs {
  namespace?: pulumi.Input<string>
  helmOverride?: pulumi.Input<HelmOverride>
  provider: pulumi.Input<OAuthProvider>
  domain: pulumi.Input<string>
  emailDomains: pulumi.Input<string[]>
  ingress: pulumi.Input<Ingress>
}

export type OAuthProvider = GithubProvider

export interface GithubProvider {
  type: 'github'
  org: string
  clientId: pulumi.Input<string>
  clientSecret: pulumi.Input<string>
  cookieSecret: pulumi.Input<string>
}

export class Oauth extends pulumi.ComponentResource {
  public readonly publicHost: pulumi.Output<string>

  constructor(name: string, args: OAuthArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:Oauth', name, args, opts)

    const helmOverride = pulumi.output(args.helmOverride)
    const provider = pulumi.output(args.provider)

    const meta = pulumi.output({
      chart: 'oauth2-proxy',
      version: helmOverride.apply((x) => x?.version ?? '7.12.17'),
      repo: 'https://oauth2-proxy.github.io/manifests',
    })

    const creds = new k8s.core.v1.Secret(
      'oauth2-proxy-creds',
      {
        metadata: {
          namespace: args.namespace,
        },
        stringData: {
          'client-id': provider.clientId,
          'client-secret': provider.clientSecret,
          'cookie-secret': provider.cookieSecret,
        },
      },
      { parent: this },
    )

    const ingress = pulumi.output(args.ingress)
    this.publicHost = ingress.apply((x) => {
      if (x.hosts === undefined || x.hosts.length !== 1) throw new Error('Expected exactly one ingress host')
      return x.hosts[0]
    })

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
          config: {
            existingSecret: creds.metadata.name,
            configFile: pulumi
              .all([
                pulumi.interpolate`email_domains = ${toGolangConfigList(args.emailDomains)}`,
                pulumi.interpolate`upstreams = ${toGolangConfigList(['file:///dev/null'])}`,
              ])
              .apply((x) => x.join('\n')),
          },
          extraArgs: {
            provider: provider.type,
            'github-org': provider.org,
            'whitelist-domain': `.${args.domain}`,
            'cookie-domain': `.${args.domain}`,
            scope: 'user:email read:org',
          },
          ingress: HelmHelpers.ingressValues(ingress, name),
          ...x?.values,
        })),
      },
      { parent: this },
    )
  }
}

function toGolangConfigList(list: pulumi.Input<string[]>): pulumi.Output<string> {
  return pulumi
    .output(list)
    .apply((x) => x.map((x) => `"${x}"`).join(','))
    .apply((x) => `[${x}]`)
}
