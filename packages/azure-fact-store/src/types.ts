import type { TokenCredential } from '@azure/identity'

export interface AzureFactStoreOptions {
  /** Key Vault URL (e.g. https://my-vault.vault.azure.net/) */
  vaultUrl: string

  /** Azure credential (default: DefaultAzureCredential) */
  credential?: TokenCredential

  /** Owner identifier used as secret name prefix and for stale cleanup */
  owner?: string

  /** Whether to delete stale facts owned by the current owner (default: true) */
  cleanupStale?: boolean
}
