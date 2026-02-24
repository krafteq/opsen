import { Serializable } from './utils'

export interface InfrastructureFact<
  TKind extends string = string,
  TInfraFactSpec = any,
  TLabelKeys extends string = string,
> {
  kind: TKind

  metadata: InfrastructureFactMetadata<TLabelKeys>

  spec: Serializable<TInfraFactSpec>

  /**
   * Stack which owns the fact
   */
  owner: string
}

export type InfrastructureFactLabelValue = string | number | boolean

export interface InfrastructureFactMetadata<TLabelKeys extends string = string> {
  name: string
  labels?: Record<TLabelKeys, InfrastructureFactLabelValue>
}
