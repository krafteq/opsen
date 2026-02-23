import { InfrastructureFact, ValueOf } from '@opsen/infra'

export type DatabaseClusterFact = InfrastructureFact<
  'DatabaseCluster',
  {
    databaseCluster: DatabaseCluster
  },
  DatabaseClusterLabels
>

export const DatabaseClusterLabels = {
  ZoneRef: 'zone-ref',
}

export type DatabaseClusterLabels = ValueOf<typeof DatabaseClusterLabels>

export type DatabaseCluster = {} & (GenericDatabaseCluster | PostgresCluster)

export interface GenericDatabaseCluster {
  type: string
  [key: string]: unknown
}

export interface PostgresCluster {
  type: 'postgres'
  version: PostgresVersion

  host: string
  publicHost: string
  username: string
  password: string
  port: number
  database: string
  ca?: string
}

export type PostgresVersion = '13' | '14' | '15' | '16' | '17'
