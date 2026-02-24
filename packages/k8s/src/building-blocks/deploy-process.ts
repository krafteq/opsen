import * as pulumi from '@pulumi/pulumi'
import * as k8s from '@pulumi/kubernetes'
import { strict as assert } from 'assert'
import {
  DeployedProcess,
  KubernetesRuntime,
  Workload,
  WorkloadProcess,
  WorkloadMetadata,
  StorageClassRequest,
  Probe,
  ProcessPortProtocol,
} from '@opsen/platform'
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

  const configMap =
    allFiles.length > 0
      ? new k8s.core.v1.ConfigMap(
          `${processFullName}-files`,
          {
            metadata: {
              namespace: args.namespace,
            },
            data: allFiles
              .map<[string, any]>((file) => [file.path, file.content])
              .reduce(
                (acc, [k, v]: [string, any]) => ({
                  ...acc,
                  [k.replace(/\//g, '_')]: v,
                }),
                {},
              ),
          },
          args.opts,
        )
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

  let volumeMounts: pulumi.Input<pulumi.Input<k8s.types.input.core.v1.VolumeMount>[]> = allFiles.map(
    (file) =>
      pulumi.output({
        name: 'config',
        mountPath: pulumi.output(file).apply((f) => f.path),
        subPath: pulumi.output(file).apply((f) => f.path.replace(/\//g, '_')),
      }) as pulumi.Output<k8s.types.input.core.v1.VolumeMount>,
  )

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
                env: Object.entries(env)
                  .filter((x) => x[1] !== undefined)
                  .map(([key, value]) => ({
                    name: key,
                    value: value,
                  })),
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
