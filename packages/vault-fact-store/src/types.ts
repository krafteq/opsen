export interface VaultFactStoreOptions {
  /** Vault server address (e.g. https://vault.example.com) */
  address: string

  /** Static token or async function returning a token */
  token: string | (() => Promise<string>)

  /** Vault Enterprise namespace */
  namespace?: string

  /** KV v2 mount path (default: 'opsen') */
  mount?: string

  /** Base path prefix under the mount (default: none — store at mount root) */
  basePath?: string

  /** Whether to delete stale facts owned by the current owner (default: true) */
  cleanupStale?: boolean

  /** Limit read to these owners only (default: all owners) */
  owners?: string[]
}
