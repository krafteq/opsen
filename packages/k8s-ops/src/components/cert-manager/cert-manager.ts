import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { HelmOverride } from '@opsen/platform'

export interface CertManagerArgs {
  namespace?: pulumi.Input<string>
  helmOverride?: pulumi.Input<HelmOverride>

  replicas?: pulumi.Input<number>

  letsencrypt?: {
    enabled: boolean
    /** Email address used for ACME registration */
    email?: pulumi.Input<string>
    staging?: boolean
  }

  zerossl?: {
    enabled: boolean
    keyId: pulumi.Input<string>
    hmacKey: pulumi.Input<string>
  }

  solvers?: pulumi.Input<pulumi.Input<Solver>[]>
}

export type Solver =
  | 'nginx'
  | {
      type: 'cloudflare'
      token: pulumi.Input<string>
    }

export type CertificateIssuer = 'letsencrypt' | 'letsencrypt-stage' | 'zerossl'

export class CertManager extends pulumi.ComponentResource {
  public readonly issuers: CertificateIssuer[]

  public constructor(name: string, args: CertManagerArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:CertManager', name, args, {
      ...opts,
      aliases: [...(opts?.aliases ?? []), { type: 'opsen-k8s:CertManager' }],
    })

    this.issuers = []

    const helmOverride = pulumi.output(args.helmOverride)
    const meta = pulumi.output({
      chart: 'cert-manager',
      version: helmOverride.apply((x) => x?.version ?? 'v1.17.1'),
      repo: 'https://charts.jetstack.io',
    })

    const chart = new k8s.helm.v3.Release(
      name,
      {
        namespace: args.namespace,
        chart: meta.chart,
        version: meta.version,
        repositoryOpts: {
          repo: meta.repo,
        },

        values: helmOverride.apply((x) => ({
          replicaCount: args.replicas ?? 1,
          installCRDs: true,
          webhook: {
            timeoutSeconds: 30,
          },
          ...x?.values,
        })),
      },
      { parent: this },
    )

    let cloudflareSecretInd = 0
    const solvers = pulumi.output(args.solvers).apply((s: Solver[] | undefined) => {
      const result = []
      if (s === undefined || s.length === 0) {
        result.push({
          http01: {
            ingress: {
              class: 'nginx',
            },
          },
        })
        return
      }

      for (const solver of s) {
        if (solver === 'nginx') {
          result.push({
            http01: {
              ingress: {
                class: 'nginx',
              },
            },
          })
          continue
        }

        if (solver.type == 'cloudflare') {
          const cloudflareSecret = new k8s.core.v1.Secret(
            `${name}-cloudflare-secret-${++cloudflareSecretInd}`,
            {
              metadata: {
                namespace: args.namespace,
              },
              type: 'Opaque',
              stringData: {
                'api-token': pulumi.output(solver.token),
              },
            },
            { parent: this },
          )
          result.push({
            dns01: {
              cloudflare: {
                apiTokenSecretRef: {
                  name: cloudflareSecret.metadata.name,
                  key: 'api-token',
                },
              },
            },
          })
        }
      }

      return result
    })

    if (args.zerossl?.enabled) {
      this.issuers.push('zerossl')

      const hmacSecret = new k8s.core.v1.Secret(
        `${name}-zerossl-hmac-key`,
        {
          metadata: {
            namespace: args.namespace,
          },
          data: {
            secret: pulumi.output(args.zerossl.hmacKey).apply((x) => Buffer.from(x).toString('base64')),
          },
        },
        { parent: this },
      )

      new k8s.apiextensions.CustomResource(
        `${name}-zerossl`,
        {
          apiVersion: 'cert-manager.io/v1',
          kind: 'ClusterIssuer',
          metadata: {
            name: 'zerossl',
          },
          spec: {
            acme: {
              server: 'https://acme.zerossl.com/v2/DV90',
              externalAccountBinding: {
                keyID: args.zerossl.keyId,
                keySecretRef: {
                  name: hmacSecret.metadata.name,
                  key: 'secret',
                },
              },
              privateKeySecretRef: {
                name: `${name}-zerossl-private-key`,
              },
              solvers: [
                {
                  http01: {
                    ingress: {
                      class: 'nginx',
                    },
                  },
                },
              ],
            },
          },
        },
        { parent: this, dependsOn: [chart] },
      )
    }

    if (args.letsencrypt) {
      this.issuers.push('letsencrypt')

      new k8s.apiextensions.CustomResource(
        `${name}-letsencrypt`,
        {
          apiVersion: 'cert-manager.io/v1',
          kind: 'ClusterIssuer',
          metadata: {
            name: 'letsencrypt',
          },
          spec: {
            acme: {
              server: 'https://acme-v02.api.letsencrypt.org/directory',
              email: args.letsencrypt.email,
              privateKeySecretRef: {
                name: `${name}-letsencrypt-private-key`,
              },
              solvers: solvers,
            },
          },
        },
        { parent: this, dependsOn: [chart] },
      )

      if (args.letsencrypt.staging) {
        this.issuers.push('letsencrypt-stage')

        new k8s.apiextensions.CustomResource(
          `${name}-letsencrypt-stage`,
          {
            apiVersion: 'cert-manager.io/v1',
            kind: 'ClusterIssuer',
            metadata: {
              name: 'letsencrypt-stage',
            },
            spec: {
              acme: {
                server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
                email: args.letsencrypt.email,
                privateKeySecretRef: {
                  name: `${name}-letsencrypt-stage-private-key`,
                },
                solvers: solvers,
              },
            },
          },
          { parent: this, dependsOn: [chart] },
        )
      }
    }
  }
}
