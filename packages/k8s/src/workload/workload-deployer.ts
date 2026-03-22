import { KubernetesServiceDeployer, ServiceDeployParams } from '../deployer'
import {
  DeployedProcess,
  DeployedServiceEndpoint,
  DeployedWorkload,
  Probe,
  ProcessPortProtocol,
  Workload,
  WorkloadProcess,
  WorkloadMetadata,
  StorageClassRequest,
  EnvVarValue,
  isSecretValue,
  isSecretRef,
  isSecretContent,
  resolveFileContent,
} from '@opsen/platform'
import type { KubernetesRuntime } from '../runtime'
import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { strict as assert } from 'assert'
import { input as inputs } from '@pulumi/kubernetes/types'
import _ from 'lodash'
import { Resource } from '@pulumi/pulumi'
import { ingressAnnotations, ingressSpec } from './ingress'

export interface WorkloadDeployParams extends ServiceDeployParams {
  ingress?: IngressInfo[]
}

export interface IngressInfo {
  isDefault: boolean
  className?: string
  domains?: string[]
  certIssuer?: string
}

export class WorkloadDeployer extends KubernetesServiceDeployer<WorkloadDeployParams> {
  public deploy(workload: Workload<KubernetesRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload> {
    return pulumi.all([workload, this.deployProcesses(workload, metadata)]).apply(([workload, processes]) => {
      return this.deployServiceEndpoints(workload, metadata, processes).apply((endpoints) => ({
        processes: processes,
        endpoints: endpoints,
      }))
    })
  }

  private deployServiceEndpoints(
    workload: pulumi.Unwrap<Workload<KubernetesRuntime>>,
    metadata: WorkloadMetadata,
    deployedProcesses: Record<string, DeployedProcess & { resources: Resource[] }>,
  ): pulumi.Output<Record<string, DeployedServiceEndpoint>> {
    const name = metadata.name
    const endpoints = workload.endpoints ?? {}

    const deployedEndpoints: Record<string, pulumi.Input<DeployedServiceEndpoint>> = {}

    _.entries(_.groupBy(_.entries(endpoints), (x) => x[1].backend.process)).forEach(([processName, endpoints]) => {
      const process = workload.processes?.[processName]
      assert(process)

      const deployedProcess = deployedProcesses[processName]
      assert(deployedProcess)

      const serviceName = this.processFullName(name, processName)
      const ingressRules: IngressDef[] = []
      const service = new k8s.core.v1.Service(
        serviceName,
        {
          metadata: {
            namespace: this.namespace,
          },
          spec: {
            selector: this.matchLabels(metadata, processName),
            ports: endpoints.map(([endpointName, endpoint]) => {
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

                const ingressGroups = findMatchingIngressGroups(hosts, this.params.ingress ?? [])
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
                protocol: this.mapToContainerPortProtocol(backendPort.protocol),
                port: servicePort,
                targetPort: backendPort.port,
              }
            }),
          },
        },
        this.options({ dependsOn: deployedProcess.resources }),
      )

      for (const [endpointName, endpoint] of endpoints) {
        const backendPort = process.ports?.[endpoint.backend.port]!
        const servicePort = endpoint.servicePort ?? backendPort.port

        deployedEndpoints[endpointName] = pulumi.output({
          host: pulumi.interpolate`${service.metadata.name}.${this.namespace}.svc.cluster.local`,
          port: servicePort,
        })
      }

      ingressRules.map(
        (rule, idx) =>
          new k8s.networking.v1.Ingress(
            idx == 0 ? serviceName : `${serviceName}-${idx + 1}`,
            {
              metadata: {
                namespace: this.namespace,
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
            this.options({ dependsOn: service }),
          ),
      )
    })

    return pulumi.all(deployedEndpoints)
  }

  private deployProcesses(
    workload: Workload<KubernetesRuntime>,
    metadata: WorkloadMetadata,
  ): pulumi.Output<Record<string, DeployedProcess & { resources: Resource[] }>> {
    return pulumi.all(
      pulumi.output(workload).apply((workload) => {
        return Object.fromEntries(
          Object.entries(workload.processes ?? {})
            .filter(([_, process]) => !process.disabled)
            .map(([processName, process]) => {
              return [processName, this.deployProcess(workload, metadata, processName, process)]
            }),
        )
      }),
    )
  }

  private deployProcess(
    workload: pulumi.Unwrap<Workload<KubernetesRuntime>>,
    metadata: WorkloadMetadata,
    processName: string,
    process: pulumi.Unwrap<WorkloadProcess<KubernetesRuntime>>,
  ): pulumi.Output<DeployedProcess & { resources: Resource[] }> {
    const name = metadata.name
    const processFullName = this.processFullName(name, processName)
    const allFiles = [...(workload.files ?? []), ...(process.files ?? [])]
    const volumes = {
      ...(workload.volumes ?? {}),
      ...(process.volumes ?? {}),
    }
    const env = {
      ...(workload.env ?? {}),
      ...(process.env ?? {}),
    }
    const image = process.image ?? workload.image
    assert(image)

    const cmd = process.cmd ?? workload.cmd

    let deployStrategy = process.deployStrategy ?? workload.deployStrategy

    if (Object.entries(volumes).length > 0) {
      if (deployStrategy?.type === 'RollingUpdate') {
        throw new Error(
          `Invalid Deploy Strategy for process ${processName} in ${name}: there are attached volumes. Only 'Recreate' is supported`,
        )
      }
      deployStrategy = { type: 'Recreate' }
    }

    const scale = process.scale ?? workload.scale ?? 1
    const healthcheck = {
      ...(workload.healthcheck ?? {}),
      ...(process.healthcheck ?? {}),
    }

    const ports = {
      ...(process.ports ?? {}),
    }

    const resources = process._k8s?.resources ?? workload._k8s?.resources

    // Partition files into plain (ConfigMap) and secret (Secret) groups
    const plainFiles = allFiles.filter((f) => !isSecretContent(f.content))
    const secretFiles = allFiles.filter((f) => {
      if (!isSecretContent(f.content)) return false
      if (isSecretRef(f.content as EnvVarValue)) return false
      return true
    })
    const secretRefFiles = allFiles.filter((f) => isSecretContent(f.content) && isSecretRef(f.content as EnvVarValue))

    const configMap =
      plainFiles.length > 0
        ? new k8s.core.v1.ConfigMap(
            `${processFullName}-files`,
            {
              metadata: {
                namespace: this.namespace,
              },
              data: Object.fromEntries(
                plainFiles
                  .filter((f) => f.encoding !== 'base64')
                  .map((f) => [f.path.replace(/\//g, '_'), f.content as string]),
              ),
              binaryData: Object.fromEntries(
                plainFiles
                  .filter((f) => f.encoding === 'base64')
                  .map((f) => [f.path.replace(/\//g, '_'), f.content as string]),
              ),
            },
            this.options(),
          )
        : undefined

    const secretFilesResource =
      secretFiles.length > 0
        ? new k8s.core.v1.Secret(
            `${processFullName}-secret-files`,
            {
              metadata: {
                namespace: this.namespace,
              },
              ...(secretFiles.some((f) => f.encoding === 'base64')
                ? {
                    data: Object.fromEntries(
                      secretFiles
                        .filter((f) => f.encoding === 'base64')
                        .map((f) => [f.path.replace(/\//g, '_'), resolveFileContent(f.content)]),
                    ),
                  }
                : {}),
              stringData: Object.fromEntries(
                secretFiles
                  .filter((f) => f.encoding !== 'base64')
                  .map((f) => [f.path.replace(/\//g, '_'), resolveFileContent(f.content)]),
              ),
            },
            this.options(),
          )
        : undefined

    // Partition env vars: plain, inline secrets, and secret refs
    const plainEnvEntries = Object.entries(env).filter(([, v]) => v !== undefined && typeof v === 'string')
    const secretEnvEntries = Object.entries(env).filter(([, v]) => v !== undefined && isSecretValue(v as EnvVarValue))
    const secretRefEnvEntries = Object.entries(env).filter(([, v]) => v !== undefined && isSecretRef(v as EnvVarValue))

    // Create K8s Secret for inline secret env vars
    const secretEnvResource =
      secretEnvEntries.length > 0
        ? new k8s.core.v1.Secret(
            `${processFullName}-secret-env`,
            {
              metadata: {
                namespace: this.namespace,
              },
              stringData: Object.fromEntries(
                secretEnvEntries.map(([key, v]) => [key, (v as { type: 'secret'; value: string }).value]),
              ),
            },
            this.options(),
          )
        : undefined

    const secretEnvName = secretEnvResource
      ? secretEnvResource.id.apply((s) => s.split('/')[s.split('/').length - 1])
      : undefined

    const pvcs = Object.entries(volumes).map(([pvcName, pvcRequest]) => {
      if (typeof pvcRequest._k8s?.storage == 'string')
        return {
          name: pvcRequest._k8s.storage,
          k8sName: pulumi.output(pvcRequest._k8s.storage),
        }

      const storageClass: StorageClassRequest = pvcRequest._k8s?.storage?.class ?? { default: true }

      const size = pvcRequest._k8s?.storage?.size ?? pvcRequest.size
      if (!size) {
        throw new Error(`Cannot deploy ${metadata.name}: size of the volume ${pvcName} is not provided`)
      }

      return {
        name: pvcName,
        k8sName: new k8s.core.v1.PersistentVolumeClaim(
          `${processFullName}-pvc-${pvcName}`,
          {
            metadata: {
              namespace: this.namespace,
              annotations: {
                'pulumi.com/skipAwait': 'true',
              },
            },
            spec: {
              storageClassName: this.storageClass(storageClass, {
                failIfNoMatch: true,
              }).apply((x) => x!),
              accessModes: ['ReadWriteOnce'],
              resources: {
                requests: {
                  storage: size,
                },
              },
            },
          },
          this.options(),
        ).metadata.name,
      }
    })

    const k8sVolumes: pulumi.Input<pulumi.Input<k8s.types.input.core.v1.Volume>[]> = pvcs
      .map(
        (pvcData) =>
          ({
            name: `pvc-${pvcData.name}`,
            persistentVolumeClaim: {
              claimName: pvcData.k8sName,
              readOnly: false,
            },
          }) as k8s.types.input.core.v1.Volume,
      )
      .concat(
        configMap
          ? [
              {
                name: 'config',
                configMap: {
                  name: configMap.id.apply((s) => s.split('/')[s.split('/').length - 1]),
                },
              },
            ]
          : [],
      )
      .concat(
        secretFilesResource
          ? [
              {
                name: 'secret-files',
                secret: {
                  secretName: secretFilesResource.id.apply((s) => s.split('/')[s.split('/').length - 1]),
                },
              },
            ]
          : [],
      )
      .concat(
        secretRefFiles.map((f, i) => {
          const ref = f.content as { type: 'secret'; valueRef: Record<string, string> }
          return {
            name: `secret-ref-file-${i}`,
            secret: {
              secretName: ref.valueRef.secretName,
              items: ref.valueRef.key ? [{ key: ref.valueRef.key, path: f.path.split('/').pop()! }] : undefined,
            },
          } as k8s.types.input.core.v1.Volume
        }),
      )

    // Volume mounts for plain files (ConfigMap)
    let volumeMounts: pulumi.Input<pulumi.Input<k8s.types.input.core.v1.VolumeMount>[]> = plainFiles.map(
      (file) =>
        pulumi.output({
          name: 'config',
          mountPath: pulumi.output(file).apply((f) => f.path),
          subPath: pulumi.output(file).apply((f) => f.path.replace(/\//g, '_')),
        }) as pulumi.Output<k8s.types.input.core.v1.VolumeMount>,
    )

    // Volume mounts for secret files (inline Secret)
    if (secretFiles.length > 0) {
      const secretFileMounts = secretFiles.map((file) => ({
        name: 'secret-files',
        mountPath: file.path,
        subPath: file.path.replace(/\//g, '_'),
      }))
      volumeMounts = pulumi.output(volumeMounts).apply((vms) => [...vms, ...secretFileMounts])
    }

    // Volume mounts for SecretRef files
    if (secretRefFiles.length > 0) {
      const refFileMounts = secretRefFiles.map((file, i) => ({
        name: `secret-ref-file-${i}`,
        mountPath: file.path,
        subPath: file.path.split('/').pop()!,
      }))
      volumeMounts = pulumi.output(volumeMounts).apply((vms) => [...vms, ...refFileMounts])
    }

    if (Object.entries(volumes).length > 0) {
      volumeMounts = pulumi.all([volumeMounts, volumes]).apply(([vms, pvcs]) =>
        vms.concat(
          ...Object.entries(pvcs).map(([pvcName, pvcRequest]) => ({
            name: `pvc-${pvcName}`,
            mountPath: pvcRequest.path,
          })),
        ),
      )
    }

    const deployment = new k8s.apps.v1.Deployment(
      processFullName,
      {
        metadata: {
          namespace: this.namespace,
        },
        spec: {
          replicas: scale,
          selector: {
            matchLabels: this.matchLabels(metadata, processName),
          },
          ...(deployStrategy ? { strategy: { type: deployStrategy.type } } : undefined),
          template: {
            metadata: {
              labels: { ...this.matchLabels(metadata, processName) },
            },
            spec: {
              restartPolicy: 'Always',
              imagePullSecrets: this.imagePullSecrets({ image: image }),
              nodeSelector: this.nodeSelectors,
              containers: [
                {
                  image: image,
                  name: processFullName,
                  args: cmd,
                  env: [
                    ...plainEnvEntries.map(([key, value]) => ({
                      name: key,
                      value: value as string,
                    })),
                    ...secretEnvEntries.map(([key]) => ({
                      name: key,
                      valueFrom: {
                        secretKeyRef: {
                          name: secretEnvName!,
                          key,
                        },
                      },
                    })),
                    ...secretRefEnvEntries.map(([key, v]) => {
                      const ref = v as { type: 'secret'; valueRef: Record<string, string> }
                      return {
                        name: key,
                        valueFrom: {
                          secretKeyRef: {
                            name: ref.valueRef.secretName,
                            key: ref.valueRef.key,
                          },
                        },
                      }
                    }),
                  ],
                  ports: Object.entries(ports).map(([key, value]) => ({
                    name: key,
                    containerPort: value.port,
                    protocol: this.mapToContainerPortProtocol(value.protocol),
                  })),
                  livenessProbe: this.mapProbe(healthcheck?.liveness),
                  readinessProbe: this.mapProbe(healthcheck?.readiness),
                  startupProbe: this.mapProbe(healthcheck?.startup),
                  resources: this.getResourceRequirements(resources ?? defaultResources),
                  volumeMounts: volumeMounts,
                },
              ],
              volumes: k8sVolumes,
            },
          },
        },
      },
      this.options({
        replaceOnChanges: ['spec.strategy'],
      }),
    )
    return pulumi.output({
      resources: [deployment] as Resource[],
    })
  }

  private matchLabels(metadata: WorkloadMetadata, processName: string): Record<string, pulumi.Input<string>> {
    return {
      app: this.processFullName(metadata.name, processName),
    }
  }

  private processFullName(name: string, processName: string): string {
    return processName ? name : `${name}-${processName}`
  }

  private mapToContainerPortProtocol(protocol: ProcessPortProtocol): string {
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
    }
  }

  private mapProbe(x?: Probe) {
    if (!x) return undefined

    const actionType = x.action.type

    const probe: inputs.core.v1.Probe = {
      initialDelaySeconds: x.initialDelaySeconds,
      periodSeconds: x.periodSeconds,
      timeoutSeconds: x.timeoutSeconds,
      failureThreshold: x.failureThreshold,
      successThreshold: x.successThreshold,
    }
    switch (actionType) {
      case 'exec':
        probe.exec = {
          command: x.action.cmd,
        }
        break
      case 'http-get':
        throw new Error(`Action type ${actionType} is not supported in current version`)
      default:
        throw new Error(`Action type ${actionType} is not supported`)
    }
    return probe
  }
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

const defaultResources = {
  cpu: '50m/100m',
  memory: '100Mi/500Mi',
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
