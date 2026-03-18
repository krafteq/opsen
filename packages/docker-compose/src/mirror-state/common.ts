import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { PathLike } from 'node:fs'
import type { File } from './types'

export function normalizeBuffer(data: Buffer): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.from(data)
  if (typeof data === 'object') return Buffer.from(Object.values(data))
  throw new Error('Unsupported data format for buffer')
}

export function getCurrentFormattedDate(): string {
  const now = new Date()

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const formatted = formatter.format(now)

  const [datePart, timePart] = formatted.split(', ')
  const [day, month, year] = datePart.split('/')

  return `${day}-${month}-${year}:${timePart}`
}

export function computeMetaHash(files: File[]): Buffer {
  const hash = createHash('sha256')
  files.sort()

  for (const file of files) {
    const fileInfo = `${file.path}:${file.name}:${normalizeBuffer(file.data)}`
    hash.update(fileInfo)
  }

  return hash.digest()
}

export function compareStates(remoteState: File[], localState: File[]): boolean {
  if (localState.length > remoteState.length) return false

  for (const file1 of localState) {
    const file2 = remoteState.find((f) => f.path === file1.path)
    if (!file2 || !compareFiles(file1, file2)) return false
  }
  return true
}

export function compareFiles(file1: File, file2: File): boolean {
  const data1 = normalizeBuffer(file1.data)
  const data2 = normalizeBuffer(file2.data)

  return data1.equals(data2)
}

export function stripBasePath(fullPath: string | PathLike, basePath: string | PathLike): string {
  const normalizedFull = posix.normalize(fullPath.toString())
  const normalizedBase = posix.normalize(basePath.toString()).replace(/\/+$/, '')

  if (!normalizedFull.startsWith(normalizedBase)) {
    throw new Error(`Path "${fullPath}" is not under base path "${basePath}"`)
  }

  return normalizedFull.slice(normalizedBase.length + 1)
}
