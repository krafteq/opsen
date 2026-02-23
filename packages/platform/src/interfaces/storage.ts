export interface StorageClassMeta {
  name: string
  labels: Record<string, string | boolean>
}

/**
 * Describe PVC to use: existing name or create new with size/class
 */
export type Storage =
  | string
  | {
      size: StorageSize
      class: StorageClassRequest
    }

/** Kubernetes size format like "100Gi" */
export type StorageSize = string

/** Reference class by name or by labels: { "fstype": "xfs", "type": "ssd" } */
export type StorageClassRequest = string | Record<string, string | boolean>
