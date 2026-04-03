import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import * as random from '@pulumi/random'
import { HelmOverride, Ingress, Persistence } from '@opsen/platform'
import { HelmHelpers } from '../helpers/helm-helpers'

export interface PrometheusArgs {
  namespace?: pulumi.Input<string>
  persistence: {
    prometheus: pulumi.Input<Persistence>
    grafana: pulumi.Input<Persistence>
    alertManager: pulumi.Input<Persistence>
  }
  helmOverride?: pulumi.Input<HelmOverride>
  ingress?: {
    alertHost?: pulumi.Input<string>
    promHost?: pulumi.Input<string>
    grafanaHost?: pulumi.Input<string>
    oauthUrl?: pulumi.Input<string>
  } & Ingress
  pagerDuty?: {
    url: pulumi.Input<string>
    secret: pulumi.Input<string>
  }
}

export interface UserPassword {
  user: string
  password: string
}

export class PrometheusStack extends pulumi.ComponentResource {
  public readonly grafanaAdmin: pulumi.Output<UserPassword>
  public readonly status: pulumi.Output<k8s.types.output.helm.v3.ReleaseStatus>

  constructor(name: string, args: PrometheusArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:PrometheusStack', name, args, {
      ...opts,
      aliases: [...(opts?.aliases ?? []), { type: 'proxima-k8s:PrometheusStack' }],
    })

    const helmOverride = pulumi.output(args.helmOverride)

    const meta = pulumi.output({
      chart: 'kube-prometheus-stack',
      version: helmOverride.apply((x) => x?.version ?? '70.2.0'),
      repo: 'https://prometheus-community.github.io/helm-charts',
    })

    const password = new random.RandomPassword(
      `${name}-admin-password`,
      {
        length: 32,
        special: false,
      },
      { parent: this },
    )

    const ingress = pulumi.output(args.ingress).apply((x) => ({ tls: true, sslRedirect: true, ...x }))
    const persistence = pulumi.all({
      prometheus: pulumi.output(args.persistence.prometheus),
      grafana: pulumi.output(args.persistence.grafana),
      alertManager: pulumi.output(args.persistence.alertManager),
    })

    const prom = new k8s.helm.v3.Release(
      name,
      {
        namespace: args?.namespace,
        chart: meta.chart,
        version: meta.version,
        repositoryOpts: { repo: meta.repo },
        values: pulumi.all([helmOverride, persistence]).apply(([x, p]) => ({
          prometheusOperator: {
            createCustomResource: false,
            tls: { enabled: false },
            admissionWebhooks: { enabled: false },
          },
          coreDns: { enabled: false },
          kubeDns: { enabled: true },
          grafana: {
            adminPassword: password.result,
            ingress: HelmHelpers.ingressValues(
              ingress.apply((x) => (x?.grafanaHost ? { ...x, hosts: [x?.grafanaHost] } : undefined)),
              `${name}-grafana`,
            ),
            persistence: {
              enabled: p.grafana.enabled,
              storageClassName: p.grafana.storageClass,
              size: `${p.grafana.sizeGB}Gi`,
            },
            deploymentStrategy: { type: 'Recreate' },
            rbac: { pspEnabled: false },
            sidecar: {
              datasources: {
                enabled: true,
                label: 'grafana_datasource',
                labelValue: '1',
              },
              dashboard: {
                enabled: true,
                labelValue: '1',
              },
            },
          },
          prometheus: {
            ingress: ingress.apply((x) =>
              HelmHelpers.ingressValues(
                x?.promHost && x?.oauthUrl
                  ? {
                      ...x,
                      hosts: [x?.promHost],
                      auth: {
                        signInUrl: `${x.oauthUrl}/oauth2/start`,
                        authUrl: `${x.oauthUrl}/oauth2/auth`,
                      },
                    }
                  : undefined,
                `${name}-prom`,
              ),
            ),
            storageSpec: {
              volumeClaimTemplate: {
                spec: {
                  storageClassName: p.prometheus.storageClass,
                  accessModes: ['ReadWriteOnce'],
                  resources: {
                    requests: {
                      storage: `${p.prometheus.sizeGB}Gi`,
                    },
                  },
                },
                selector: {},
              },
            },
            prometheusSpec: {
              serviceMonitorSelectorNilUsesHelmValues: false,
              podMonitorSelectorNilUsesHelmValues: false,
            },
          },
          alertmanager: {
            enabled: true,
            storage: {
              volumeClaimTemplate: {
                spec: {
                  storageClassName: p.alertManager.storageClass,
                  accessModes: ['ReadWriteOnce'],
                  resources: {
                    requests: {
                      storage: `${p.alertManager.sizeGB}Gi`,
                    },
                  },
                },
                selector: {},
              },
            },
            ...(args.pagerDuty
              ? {
                  config: {
                    global: {
                      pagerduty_url: args.pagerDuty.url,
                    },
                    route: {
                      receiver: 'alertOperator',
                      group_by: ['job'],
                      routes: [
                        {
                          receiver: 'null',
                          matchers: ['alertname=~"InfoInhibitor|Watchdog"'],
                        },
                      ],
                    },
                    receivers: [
                      {
                        name: 'alertOperator',
                        pagerduty_configs: [{ service_key: args.pagerDuty.secret }],
                      } as any,
                      {
                        name: 'null',
                      },
                    ],
                  },
                }
              : {}),
            ingress: ingress.apply((x) =>
              HelmHelpers.ingressValues(
                x?.alertHost && x?.oauthUrl
                  ? {
                      ...x,
                      hosts: [x?.alertHost],
                      auth: {
                        signInUrl: `${x.oauthUrl}/oauth2/start`,
                        authUrl: `${x.oauthUrl}/oauth2/auth`,
                      },
                    }
                  : undefined,
                `${name}-am`,
              ),
            ),
          },
          ...x?.values,
        })),
      },
      { parent: this },
    )

    this.status = prom.status
    this.grafanaAdmin = password.result.apply((pass) => ({
      user: 'admin',
      password: pass,
    }))
  }
}
