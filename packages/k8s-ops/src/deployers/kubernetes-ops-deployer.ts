import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import * as random from '@pulumi/random'
import { KubernetesDeployer } from '@opsen/k8s'
import { Persistence } from '@opsen/platform'
import * as components from '../components'
import { strict as assert } from 'assert'

export class KubernetesOpsDeployer extends KubernetesDeployer {
  public deploy(args: KubernetesOperatorsArgs): pulumi.Output<DeployedKubernetesOps> {
    let publicIngressController: components.ingressNginx.IngressNginxController | undefined

    let internalIngressController: components.ingressNginx.IngressNginxController | undefined

    const ingressClasses: string[] = []
    const certIssuers: string[] = []

    const opsNamespace = new k8s.core.v1.Namespace(
      args.namespace,
      {
        metadata: {
          name: args.namespace,
        },
      },
      this.options(),
    )

    if (!args.dns.disabled) {
      assert(args.dns.cloudflare)
      new components.externalDns.ExternalDns(
        'external-dns',
        {
          namespace: opsNamespace.metadata.name,
          provider: {
            type: 'cloudflare',
            apiToken: args.dns.cloudflare?.token,
          },
        },
        this.options(),
      )
    }

    if (!args.ingress.disabled) {
      if (args.ingress.public.enabled) {
        publicIngressController = new components.ingressNginx.IngressNginxController(
          'ingress-ctrl',
          {
            namespace: opsNamespace.metadata.name,
            ingressClass: 'nginx',
            service: {
              annotations: args.ingress.public.annotations,
            },
          },
          this.options(),
        )
        ingressClasses.push('nginx')
      }

      if (args.ingress.internal.enabled) {
        internalIngressController = new components.ingressNginx.IngressNginxController(
          'internal-ingress-ctrl',
          {
            namespace: opsNamespace.metadata.name,
            default: true,
            service: {
              annotations: args.ingress.internal.annotations,
            },
            ingressClass: 'internal-nginx',
          },
          this.options(),
        )
        ingressClasses.push('internal-nginx')
      }
    }

    let certManager: components.certManager.CertManager | undefined
    if (!args.certManager.disabled) {
      certManager = new components.certManager.CertManager(
        'cert-manager',
        {
          namespace: opsNamespace.metadata.name,
          zerossl: args.certManager.zerossl,
          letsencrypt: args.certManager.letsencrypt,
          solvers: args.certManager.cloudflare
            ? [{ type: 'cloudflare', token: args.certManager.cloudflare.token }]
            : undefined,
        },
        this.options(),
      )

      certIssuers.push(...certManager.issuers)
    }

    let oauth: components.oauth2.Oauth | undefined
    if (!args.oauth.disabled) {
      if (certIssuers.length === 0) {
        throw new Error('Cannot deploy OAuth proxy since cert issuer is not specified')
      }

      if (ingressClasses.length === 0) {
        throw new Error('Cannot deploy OAuth proxy since ingress class is not specified')
      }

      const pass = new random.RandomPassword('oauth-cookie-secret', {
        length: 32,
      })

      const secretValue = pass.result.apply((x) =>
        Buffer.from(Buffer.from(x).toString('base64').substring(0, 32)).toString('base64'),
      )

      oauth = new components.oauth2.Oauth(
        'oauth',
        {
          namespace: opsNamespace.metadata.name,
          helmOverride: {
            version: '7.12.17',
          },
          provider: {
            type: 'github',
            org: args.oauth.github.org,
            clientId: args.oauth.github.clientId,
            clientSecret: args.oauth.github.clientSecret,
            cookieSecret: secretValue,
          },
          ingress: {
            hosts: [`oauth.${args.host}`],
            issuer: certIssuers[0],
            class: ingressClasses.find((x) => !x.includes('internal')) ?? ingressClasses[0],
            tls: true,
            sslRedirect: true,
          },
          domain: args.host,
          emailDomains: args.oauth.emailDomains,
        },
        this.options(),
      )
    }

    let loki: components.loki.Loki | undefined
    let prometheus: components.prometheus.PrometheusStack | undefined
    let grafanaHost: string | undefined
    let prometheusHost: string | undefined
    let alertManagerHost: string | undefined
    if (!args.monitoring.disabled) {
      if (!args.monitoring.loki.disabled) {
        loki = new components.loki.Loki(
          'loki',
          {
            namespace: opsNamespace.metadata.name,
            persistence: this.toPersistence(args.monitoring.loki.storageSizeGB),
            retentionHours: args.monitoring.loki.retentionHours,
          },
          this.options(),
        )
      }

      const ingressClass = ingressClasses.find((x) => x.includes('internal')) ?? ingressClasses[0]
      const installIngress =
        ingressClass?.includes('internal') === true || (certIssuers.length > 0 && oauth !== undefined)

      if (!installIngress) {
        console.warn('Prometheus Ingress will not be installed due to security')
      }

      alertManagerHost = `al.${args.host}`
      grafanaHost = `grafana.${args.host}`
      prometheusHost = `prom.${args.host}`
      prometheus = new components.prometheus.PrometheusStack(
        'prometheus',
        {
          namespace: opsNamespace.metadata.name,
          persistence: {
            prometheus: this.toPersistence(args.monitoring.prometheus.storageSizeGB),
            grafana: this.toPersistence(args.monitoring.grafana.storageSizeGB),
            alertManager: this.toPersistence(args.monitoring.alertManager.storageSizeGB),
          },
          ingress: installIngress
            ? {
                alertHost: alertManagerHost,
                oauthUrl: oauth ? pulumi.interpolate`https://${oauth?.publicHost}` : undefined,
                issuer: certIssuers[0],
                class: ingressClass,
                grafanaHost: grafanaHost,
                promHost: prometheusHost,
              }
            : undefined,
          pagerDuty: args.monitoring.alertManager.pagerDuty
            ? {
                secret: args.monitoring.alertManager.pagerDuty.secret,
                url: args.monitoring.alertManager.pagerDuty.url,
              }
            : undefined,
        },
        this.options(),
      )

      if (loki) {
        new k8s.core.v1.ConfigMap(
          'loki-grafana-datasource',
          {
            metadata: {
              namespace: opsNamespace.metadata.name,
              labels: {
                grafana_datasource: '1',
              },
            },
            data: {
              'loki-datasource.yaml': pulumi.interpolate`apiVersion: 1
deleteDatasources:
  - name: Loki
    orgId: 1
datasources:
  - name: Loki
    type: loki
    access: proxy
    url: ${loki.clusterUrl}`,
            },
          },
          this.options(),
        )
      }
    }

    return pulumi
      .all([
        publicIngressController?.publicIP,
        internalIngressController?.publicIP,
        prometheus?.grafanaAdmin,
        certManager,
        args.host,
      ])
      .apply((x) => {
        const deployedOps: DeployedKubernetesOps = {
          ingress: {
            ...(x[0]
              ? {
                  public: {
                    ip: x[0],
                    className: ingressClasses.find((x) => !x.includes('internal'))!,
                  },
                }
              : undefined),
            ...(x[1]
              ? {
                  internal: {
                    ip: x[1],
                    className: ingressClasses.find((x) => x.includes('internal'))!,
                  },
                }
              : undefined),
          },
          grafana:
            x[2] && grafanaHost
              ? {
                  url: `https://${grafanaHost}`,
                  user: x[2].user,
                  password: x[2].password,
                }
              : undefined,
          prometheus: prometheusHost
            ? {
                url: `https://${prometheusHost}`,
              }
            : undefined,
          alertManager: alertManagerHost
            ? {
                url: `https://${alertManagerHost}`,
              }
            : undefined,
          certificateIssuers: x[3]?.issuers ?? [],
          host: x[4],
        }
        return deployedOps
      })
  }

  private toPersistence(storageSizeGb: number | undefined): Persistence {
    if (storageSizeGb === undefined) {
      return { enabled: false }
    }

    return {
      sizeGB: storageSizeGb,
      enabled: true,
      storageClass: this.storageClass({ type: 'ssd' }),
    }
  }
}

export interface DeployedKubernetesOps {
  ingress?: Partial<Record<'internal' | 'public', { ip: string; className: string }>>
  grafana?: {
    url: string
    user: string
    password: string
  }
  prometheus?: {
    url: string
  }
  alertManager?: {
    url: string
  }
  certificateIssuers: string[]
  host: string
}

export interface SubsystemBase {
  disabled?: false
}

export interface Disabled {
  disabled: true
}

export interface KubernetesOperatorsArgs {
  host: string
  namespace: string
  ingress:
    | (Record<
        'internal' | 'public',
        {
          enabled: boolean
          annotations?: pulumi.Input<Record<string, pulumi.Input<string>>>
        }
      > &
        SubsystemBase)
    | Disabled
  dns:
    | ({
        cloudflare?: {
          token: pulumi.Input<string>
        }
      } & SubsystemBase)
    | Disabled
  certManager:
    | ({
        letsencrypt?: {
          enabled: boolean
          email?: string
          staging?: boolean
        }
        zerossl?: {
          enabled: boolean
          keyId: string
          hmacKey: string
        }
        cloudflare?: {
          token: pulumi.Input<string>
        }
      } & SubsystemBase)
    | Disabled
  monitoring:
    | ({
        prometheus: {
          storageSizeGB?: number
        }
        alertManager: {
          storageSizeGB?: number
          pagerDuty?: {
            url: pulumi.Input<string>
            secret: pulumi.Input<string>
          }
        }
        loki:
          | {
              retentionHours: number
              storageSizeGB?: number
              disabled?: false
            }
          | Disabled
        grafana: {
          storageSizeGB?: number
        }
      } & SubsystemBase)
    | Disabled
  oauth:
    | ({
        github: {
          org: string
          clientId: string
          clientSecret: string
        }
        emailDomains: string[]
      } & SubsystemBase)
    | Disabled
}
