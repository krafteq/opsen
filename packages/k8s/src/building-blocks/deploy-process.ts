import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { strict as assert } from 'assert'
import {
  DeployedProcess,
  Workload,
  WorkloadProcess,
  WorkloadMetadata,
  StorageClassRequest,
  Probe,
  ProcessPortProtocol,
  EnvVarValue,
  isSecretValue,
  isSecretRef,
  isSecretContent,
  resolveFileContent,
} from '@opsen/platform'
import type { KubernetesRuntime } from '../runtime'
import { Resource } from '@pulumi/pulumi'
import { input as inputs } from '@pulumi/kubernetes/types'
import { parseResourceRequirements } from './resource-requirements'
import { resolveStorageClass } from './storage-class'

export interface DeployProcessArgs {
  namespace: pulumi.Input<string>
  storageClasses?: pulumi.Input<pulumi.Input<import('@opsen/platform').StorageClassMeta>[]>
  imagePullSecrets?: pulumi.Output<{ name: string }[]>
  nodeSelectors?: pulumi.Input<Record<string, string>>
  opts?: pulumi.CustomResourceOptions
}

const DEFAULT_RESOURCES = {
  cpu: '50m/100m',
  memory: '100Mi/500Mi',
}

/**
 * Deploy a single Kubernetes process (Deployment + ConfigMap + PVCs).
 *
 * This is the standalone equivalent of `WorkloadDeployer.deployProcess()`.
 */
export function deployK8sProcess(
  workload: pulumi.Unwrap<Workload<KubernetesRuntime>>,
  metadata: WorkloadMetadata,
  processName: string,
  process: pulumi.Unwrap<WorkloadProcess<KubernetesRuntime>>,
  args: DeployProcessArgs,
): pulumi.Output<DeployedProcess & { resources: Resource[] }> {
  const name = metadata.name
  const processFullName = processName ? `${name}-${processName}` : name
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

  const matchLabels: Record<string, pulumi.Input<string>> = {
    app: processFullName,
  }

  // Partition files into plain (ConfigMap) and secret (Secret) groups
  const plainFiles = allFiles.filter((f) => !isSecretContent(f.content))
  const secretFiles = allFiles.filter((f) => {
    if (!isSecretContent(f.content)) return false
    if (isSecretRef(f.content as EnvVarValue)) return false // SecretRef files mounted separately
    return true
  })
  const secretRefFiles = allFiles.filter((f) => isSecretContent(f.content) && isSecretRef(f.content as EnvVarValue))

  const configMap =
    plainFiles.length > 0
      ? new k8s.core.v1.ConfigMap(
          `${processFullName}-files`,
          {
            metadata: {
              namespace: args.namespace,
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
          args.opts,
        )
      : undefined

  const secretFilesResource =
    secretFiles.length > 0
      ? new k8s.core.v1.Secret(
          `${processFullName}-secret-files`,
          {
            metadata: {
              namespace: args.namespace,
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
          args.opts,
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
              namespace: args.namespace,
            },
            stringData: Object.fromEntries(
              secretEnvEntries.map(([key, v]) => [key, (v as { type: 'secret'; value: string }).value]),
            ),
          },
          args.opts,
        )
      : undefined

  const secretEnvName = secretEnvResource
    ? secretEnvResource.id.apply((s) => s.split('/')[s.split('/').length - 1])
    : undefined

  const storageClasses = args.storageClasses
    ? pulumi.output(args.storageClasses).apply((x) => pulumi.all(x))
    : pulumi.output([])

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
            namespace: args.namespace,
            annotations: {
              'pulumi.com/skipAwait': 'true',
            },
          },
          spec: {
            storageClassName: resolveStorageClass(storageClass, storageClasses, {
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
        args.opts,
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
        namespace: args.namespace,
      },
      spec: {
        replicas: scale,
        selector: {
          matchLabels: matchLabels,
        },
        ...(deployStrategy ? { strategy: { type: deployStrategy.type } } : undefined),
        template: {
          metadata: {
            labels: { ...matchLabels },
          },
          spec: {
            restartPolicy: 'Always',
            imagePullSecrets: args.imagePullSecrets,
            nodeSelector: args.nodeSelectors,
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
                  protocol: mapToContainerPortProtocol(value.protocol),
                })),
                livenessProbe: mapProbe(healthcheck?.liveness),
                readinessProbe: mapProbe(healthcheck?.readiness),
                startupProbe: mapProbe(healthcheck?.startup),
                resources: parseResourceRequirements(resources ?? DEFAULT_RESOURCES),
                volumeMounts: volumeMounts,
              },
            ],
            volumes: k8sVolumes,
          },
        },
      },
    },
    {
      ...args.opts,
      replaceOnChanges: ['spec.strategy'],
    },
  )

  return pulumi.output({
    resources: [deployment] as Resource[],
  })
}

function mapToContainerPortProtocol(protocol: ProcessPortProtocol): string {
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

function mapProbe(x?: Probe) {
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
