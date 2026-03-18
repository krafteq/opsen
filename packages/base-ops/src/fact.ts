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

// --- Simple Secrets ---

/** Fact kind for simple key=value secrets. */
export const SIMPLE_SECRET_KIND = 'secret' as const

export interface SimpleSecretSpec {
  value: string
}

/** A fact that holds a single secret string value. */
export type SimpleSecretFact = InfrastructureFact<typeof SIMPLE_SECRET_KIND, SimpleSecretSpec>

/** Create a simple secret fact. */
export function simpleSecret(name: string, value: string, owner: string): SimpleSecretFact {
  return {
    kind: SIMPLE_SECRET_KIND,
    metadata: { name },
    spec: { value },
    owner,
  }
}
