const VALID_PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Validate that a string is a valid Vault path segment.
 * Allows alphanumeric characters, dots, hyphens, and underscores.
 */
export function validatePathSegment(label: string, value: string): void {
  if (!VALID_PATH_SEGMENT.test(value)) {
    throw new Error(
      `${label} "${value}" is not a valid Vault path segment. Use only alphanumeric characters, dots, hyphens, and underscores.`,
    )
  }
}

/**
 * Join non-empty path segments with `/`.
 */
export function joinPath(...segments: (string | undefined)[]): string {
  return segments.filter(Boolean).join('/')
}

/**
 * Build the full secret path for a fact under an owner's scope.
 */
export function factPath(basePath: string | undefined, owner: string, kind: string, name: string): string {
  return joinPath(basePath, owner, kind, name)
}
