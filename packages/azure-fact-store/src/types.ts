import type { TokenCredential } from '@azure/identity'

export interface AzureFactStoreOptions {
  /** Key Vault URL (e.g. https://my-vault.vault.azure.net/) */
  vaultUrl: string

  /** Azure credential (default: DefaultAzureCredential) */
  credential?: TokenCredential

  /** Secret name prefix (default: 'opsen') */
  prefix?: string

  /** Whether to delete stale facts owned by the current owner (default: true) */
  cleanupStale?: boolean
}
