import type { EnvVarValue, MappedFile, SecretRef, SecretValue } from './workload'

/** Type guard: is the env value an inline secret? */
export function isSecretValue(v: EnvVarValue): v is SecretValue {
  return typeof v === 'object' && v !== null && 'type' in v && v.type === 'secret' && 'value' in v
}

/** Type guard: is the env value an external secret reference? */
export function isSecretRef(v: EnvVarValue): v is SecretRef {
  return typeof v === 'object' && v !== null && 'type' in v && v.type === 'secret' && 'valueRef' in v
}

/** Type guard: is the env value a plain string? */
export function isPlainEnvVar(v: EnvVarValue): v is string {
  return typeof v === 'string'
}

/** Extract plain string value. Works for plain + inline secret. Throws for SecretRef. */
export function resolveEnvValue(v: EnvVarValue): string {
  if (typeof v === 'string') return v
  if (isSecretValue(v)) return v.value as string
  throw new Error('Cannot resolve env value from SecretRef — use the runtime-specific secret mechanism')
}

/** Type guard: is the file content a secret (inline or ref)? */
export function isSecretContent(content: MappedFile['content']): content is SecretValue | SecretRef {
  return typeof content === 'object' && content !== null && 'type' in content && content.type === 'secret'
}

/** Extract plain string value from file content. Works for plain + inline secret. Throws for SecretRef. */
export function resolveFileContent(content: MappedFile['content']): string {
  if (typeof content === 'string') return content
  if (isSecretValue(content as EnvVarValue)) return (content as SecretValue).value as string
  throw new Error('Cannot resolve file content from SecretRef — use the runtime-specific secret mechanism')
}
