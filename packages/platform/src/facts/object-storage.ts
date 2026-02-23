import { InfrastructureFact, ValueOf } from '@opsen/infra'

export type ObjectStorageClusterFact = InfrastructureFact<
  'ObjectStorageCluster',
  {
    objectStorageCluster: ObjectStorageCluster
  },
  ObjectStorageClusterLabels
>

export const ObjectStorageClusterLabels = {
  ZoneRef: 'zone-ref',
}

export type ObjectStorageClusterLabels = ValueOf<typeof ObjectStorageClusterLabels>

export type ObjectStorageCluster = {
  type: string
  [key: string]: unknown
}
