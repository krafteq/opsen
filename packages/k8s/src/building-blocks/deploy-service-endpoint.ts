import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { strict as assert } from 'assert'
import _ from 'lodash'
import { DeployedServiceEndpoint, KubernetesRuntime, Workload } from '@opsen/platform'
import { Resource } from '@pulumi/pulumi'
import { ingressAnnotations, ingressSpec } from '../workload/ingress'
import { IngressInfo } from '../workload/workload-deployer'

export interface DeployServiceEndpointArgs {
  namespace: pulumi.Input<string>
  opts?: pulumi.CustomResourceOptions
  ingresses?: IngressInfo[]
}

/**
 * Deploy Kubernetes Service + Ingress resources for a workload's endpoints.
 *
 * This is the standalone equivalent of `WorkloadDeployer.deployServiceEndpoints()`.
 */
export function deployK8sServiceEndpoints(
  workload: pulumi.Unwrap<Workload<KubernetesRuntime>>,
  serviceName: string,
  matchLabels: Record<string, pulumi.Input<string>>,
  deployedResources: Resource[],
  args: DeployServiceEndpointArgs,
): Record<string, pulumi.Input<DeployedServiceEndpoint>> {
  const endpoints = workload.endpoints ?? {}
  const deployedEndpoints: Record<string, pulumi.Input<DeployedServiceEndpoint>> = {}

  _.entries(_.groupBy(_.entries(endpoints), (x) => x[1].backend.process)).forEach(([processName, groupedEndpoints]) => {
    const process = workload.processes?.[processName]
    assert(process)

    const ingressRules: IngressDef[] = []
    const service = new k8s.core.v1.Service(
      serviceName,
      {
        metadata: {
          namespace: args.namespace,
        },
        spec: {
          selector: matchLabels,
          ports: groupedEndpoints.map(([endpointName, endpoint]) => {
            const backendPort = process.ports?.[endpoint.backend.port]
            if (!backendPort) {
              throw new Error(
                `Cannot find backend port ${endpoint.backend.port} in ${processName} for endpoint ${endpointName}`,
              )
            }
            const servicePort = endpoint.servicePort ?? backendPort.port

            if (endpoint.ingress) {
              const hosts: string[] = []
              assert(endpoint.ingress)

              // @ts-ignore
              hosts.push(...endpoint.ingress.hosts)
              assert(hosts.length > 0, 'no hosts specified for ingress')

              const ingressGroups = findMatchingIngressGroups(hosts, args.ingresses ?? [])
              for (const ingressGroup of ingressGroups) {
                if (ingressGroup.hosts.length === 0) {
                  continue
                }

                ingressRules.push({
                  hosts: ingressGroup.hosts,
                  cors: endpoint.ingress?.enableCors ?? false,
                  path: endpoint.ingress?.path ?? '/',
                  className: ingressGroup.ingress?.className,
                  certIssuer: ingressGroup.ingress?.certIssuer,
                  backend: {
                    servicePort: servicePort,
                    protocol: backendPort.protocol,
                  },
                })
              }
            }

            return {
              name: endpointName,
              protocol: mapToContainerPortProtocol(backendPort.protocol),
              port: servicePort,
              targetPort: backendPort.port,
            }
          }),
        },
      },
      {
        ...args.opts,
        dependsOn: deployedResources,
      },
    )

    for (const [endpointName, endpoint] of groupedEndpoints) {
      const backendPort = process.ports?.[endpoint.backend.port]!
      const servicePort = endpoint.servicePort ?? backendPort.port

      deployedEndpoints[endpointName] = pulumi.output({
        host: pulumi.interpolate`${service.metadata.name}.${args.namespace}.svc.cluster.local`,
        port: servicePort,
      })
    }

    ingressRules.map(
      (rule, idx) =>
        new k8s.networking.v1.Ingress(
          idx == 0 ? serviceName : `${serviceName}-${idx + 1}`,
          {
            metadata: {
              namespace: args.namespace,
              annotations: ingressAnnotations({
                certIssuer: rule.certIssuer,
                sslRedirect: true,
                bodySize: rule.bodySize ?? '100m',
                enableCors: rule.cors,
                backendGrpc: rule.backend.protocol.toLowerCase() == 'grpc',
                backendHttps: rule.backend.protocol.toLowerCase() == 'https' || rule.backend.servicePort == 443,
              }),
            },
            spec: ingressSpec({
              host: rule.hosts,
              className: rule.className,
              tls: {
                secretName: `${serviceName}-${idx + 1}-tls`,
              },
              path: rule.path,
              backend: {
                service: {
                  name: service.metadata.name,
                  port: rule.backend.servicePort,
                },
              },
            }),
          },
          {
            ...args.opts,
            dependsOn: service,
          },
        ),
    )
  })

  return deployedEndpoints
}

function findMatchingIngressGroups(
  hosts: string[],
  ingresses: IngressInfo[],
): { hosts: string[]; ingress: IngressInfo | undefined }[] {
  const result: { hosts: string[]; ingress: IngressInfo | undefined }[] = []

  for (const host of hosts) {
    const ingress = findMatchingIngress(host, ingresses)
    let group = result.find((x) => x.ingress === ingress)
    if (!group) {
      group = { hosts: [], ingress: ingress }
      result.push(group)
    }

    group.hosts.push(host)
  }
  return result
}

function findMatchingIngress(host: string, ingresses: IngressInfo[]): IngressInfo | undefined {
  const matches = ingresses.map((x) => {
    const matchingDomains = (x.domains ?? []).filter((d) => wildTest(d, host))
    return {
      matched: matchingDomains.length > 0,
      score: _.max(matchingDomains.map((x) => x.split('.').length)) ?? 0,
      ingress: x,
    }
  })

  return _.maxBy(matches, (m) => m.score)?.ingress
}

function wildTest(wildcard: string, str: string): boolean {
  const w = wildcard.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${w.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return re.test(str)
}

function mapToContainerPortProtocol(protocol: string): string {
  switch (protocol) {
    case 'grpc':
    case 'http':
    case 'https':
    case 'tcp':
      return 'TCP'
    case 'udp':
      return 'UDP'
    case 'sctp':
      return 'SCTP'
    default:
      return 'TCP'
  }
}

interface IngressDef {
  hosts: string[]
  cors: boolean
  path: string
  className?: string
  bodySize?: string
  certIssuer?: string
  backend: {
    servicePort: number
    protocol: string
  }
}
