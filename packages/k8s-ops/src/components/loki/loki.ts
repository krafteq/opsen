import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { HelmOverride, Persistence, ComputeResources } from '@opsen/platform'

export interface LokiArgs {
  namespace?: pulumi.Input<string>
  helmOverride?: pulumi.Input<HelmOverride>
  /** The retention time for recorded logs in hours. Defaults to 7 days (168h). */
  retentionHours?: number
  /** Enable systemd-journal support. */
  scrapeSystemdJournal?: boolean
  /** Data persistence for loki's log database */
  persistence?: Persistence
  /** Pod resource request/limits */
  resources?: ComputeResources
}

export class Loki extends pulumi.ComponentResource {
  public readonly clusterUrl: pulumi.Output<string>

  public constructor(name: string, args: LokiArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen-k8s-ops:Loki', name, args, opts)

    const helmOverride = pulumi.output(args.helmOverride)
    const lokiRelease = new k8s.helm.v3.Release(
      name,
      {
        namespace: args.namespace,
        chart: 'loki',
        version: helmOverride.apply((x) => x?.version ?? '6.53.0'),
        repositoryOpts: {
          repo: 'https://grafana.github.io/helm-charts',
        },
        values: helmOverride.apply((x) => ({
          deploymentMode: 'SingleBinary',
          loki: {
            auth_enabled: false,
            commonConfig: {
              replication_factor: 1,
            },
            storage: {
              type: 'filesystem',
            },
            schemaConfig: {
              configs: [
                {
                  from: '2024-04-01',
                  store: 'tsdb',
                  object_store: 'filesystem',
                  schema: 'v13',
                  index: {
                    prefix: 'loki_index_',
                    period: '24h',
                  },
                },
              ],
            },
            limits_config: {
              retention_period: `${args.retentionHours || 168}h`,
            },
            compactor: {
              retention_enabled: true,
              delete_request_store: 'filesystem',
            },
          },
          singleBinary: {
            replicas: 1,
            persistence: args.persistence
              ? {
                  enabled: args.persistence.enabled,
                  size: `${args.persistence.sizeGB}Gi`,
                  storageClass: args.persistence.storageClass,
                }
              : { enabled: false },
            resources: args.resources,
          },
          read: { replicas: 0 },
          write: { replicas: 0 },
          backend: { replicas: 0 },
          gateway: { enabled: false },
          chunksCache: { enabled: false },
          resultsCache: { enabled: false },
          monitoring: {
            selfMonitoring: { enabled: false },
            lokiCanary: { enabled: false },
          },
          test: { enabled: false },
          minio: { enabled: false },
          ...x?.values,
        })),
        timeout: 600,
      },
      { parent: this },
    )

    this.clusterUrl = pulumi.interpolate`http://${lokiRelease.status.name}:3100`

    new k8s.helm.v3.Release(
      `${name}-promtail`,
      {
        namespace: args.namespace,
        chart: 'promtail',
        version: '6.17.1',
        repositoryOpts: {
          repo: 'https://grafana.github.io/helm-charts',
        },
        values: {
          config: {
            clients: [
              {
                url: pulumi.interpolate`http://${lokiRelease.status.name}:3100/loki/api/v1/push`,
              },
            ],
          },
          ...(args.scrapeSystemdJournal
            ? {
                extraScrapeConfigs: [
                  {
                    job_name: 'journal',
                    journal: {
                      path: '/var/log/journal',
                      max_age: '12h',
                      labels: {
                        job: 'systemd-journal',
                      },
                    },
                    relabel_configs: [
                      {
                        source_labels: ['__journal__systemd_unit'],
                        target_label: 'unit',
                      },
                      {
                        source_labels: ['__journal__hostname'],
                        target_label: 'hostname',
                      },
                    ],
                  },
                ],
                extraVolumes: [
                  {
                    name: 'journal',
                    hostPath: {
                      path: '/var/log/journal',
                    },
                  },
                ],
                extraVolumeMounts: [
                  {
                    name: 'journal',
                    mountPath: '/var/log/journal',
                    readOnly: true,
                  },
                ],
              }
            : {}),
        },
      },
      { parent: this, dependsOn: [lokiRelease] },
    )
  }
}
