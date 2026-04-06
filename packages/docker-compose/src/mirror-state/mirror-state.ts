import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { dynamic, type CustomResourceOptions, type Input } from '@pulumi/pulumi'
import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2'
import type { PathLike, WriteFileOptions } from 'node:fs'
import type { ConnectionArgs } from '../connection'

// ── Inlined types (dynamic providers must be self-contained) ──

export interface MirrorStateInputs {
  connection: Input<ConnectionArgs>
  files: Input<File[]>
  remotePath: Input<PathLike>
}

interface MirrorStateProviderInputs {
  connection: ConnectionArgs
  files: File[]
  remotePath: PathLike
}

interface File {
  name: string
  parentPath: PathLike
  path: PathLike
  data: Buffer
  options?: WriteFileOptions
}

// ── Inlined connection helper ──

function toSsh2ConnectConfig(args: ConnectionArgs): ConnectConfig {
  return {
    host: args.host,
    port: args.port,
    username: args.user,
    privateKey: args.privateKey,
  }
}

// ── Inlined common utilities ──

function normalizeBuffer(data: Buffer): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.from(data)
  if (typeof data === 'object') return Buffer.from(Object.values(data))
  throw new Error('Unsupported data format for buffer')
}

function getCurrentFormattedDate(): string {
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

function computeMetaHash(files: File[]): Buffer {
  const hash = createHash('sha256')
  files.sort()

  for (const file of files) {
    const fileInfo = `${file.path}:${file.name}:${normalizeBuffer(file.data)}`
    hash.update(fileInfo)
  }

  return hash.digest()
}

function compareStates(remoteState: File[], localState: File[]): boolean {
  if (localState.length > remoteState.length) return false

  for (const file1 of localState) {
    const file2 = remoteState.find((f) => f.path === file1.path)
    if (!file2 || !compareFiles(file1, file2)) return false
  }
  return true
}

function compareFiles(file1: File, file2: File): boolean {
  const data1 = normalizeBuffer(file1.data)
  const data2 = normalizeBuffer(file2.data)

  return data1.equals(data2)
}

function stripBasePath(fullPath: string | PathLike, basePath: string | PathLike): string {
  const normalizedFull = posix.normalize(fullPath.toString())
  const normalizedBase = posix.normalize(basePath.toString()).replace(/\/+$/, '')

  if (!normalizedFull.startsWith(normalizedBase)) {
    throw new Error(`Path "${fullPath}" is not under base path "${basePath}"`)
  }

  return normalizedFull.slice(normalizedBase.length + 1)
}

// ── Inlined SSH utilities ──

function connectSSHClient(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()

    client.on('ready', () => {
      resolve(client)
    })

    client.on('error', (err) => {
      reject(err)
    })

    client.connect(config)
  })
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err)
      } else {
        sftp.end = () => client.end()
        resolve(sftp)
      }
    })
  })
}

function connectSFTP(config: ConnectConfig): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const client = new Client()

    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end()
          reject(err)
        } else {
          sftp.end = () => client.end()
          resolve(sftp)
        }
      })
    })

    client.on('error', reject)
    client.connect(config)
  })
}

function statAsync(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

function mkdirAsync(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
  })
}

function symlinkAsync(sftp: SFTPWrapper, targetPath: string, linkPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.symlink(targetPath, linkPath, (err) => (err ? reject(err) : resolve()))
  })
}

function readDirAsync(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

function readFileAsync(sftp: SFTPWrapper, filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(filePath, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

function isDirectory(entry: FileEntryWithStats): boolean {
  return entry.attrs.isDirectory?.() ?? entry.longname.startsWith('d')
}

function isFile(entry: FileEntryWithStats): boolean {
  return entry.attrs.isFile?.() ?? entry.longname.startsWith('-')
}

function directoryExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return statAsync(sftp, path).then(
    () => true,
    () => false,
  )
}

function execCommandAsync(
  conn: Client,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)

      let stdout = ''
      let stderr = ''

      stream
        .on('close', (code: number) => {
          if (code === 0) {
            resolve({ stdout, stderr, code })
          } else {
            const error = new Error(`Command failed with exit code ${code}: ${stderr}`)
            reject(error)
          }
        })
        .on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        .stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })
    })
  })
}

async function ensureRemoteDirectory(sftp: SFTPWrapper, dir: string): Promise<void> {
  const segments = dir.split('/').filter(Boolean)
  let current = ''

  for (const segment of segments) {
    current += `/${segment}`

    if (!(await directoryExists(sftp, current))) {
      await mkdirAsync(sftp, current)
    }
  }
}

async function uploadFile(sftp: SFTPWrapper, file: File, remotePath: string): Promise<void> {
  const data = normalizeBuffer(file.data)

  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath)

    writeStream.on('close', () => {
      resolve()
    })

    writeStream.on('error', (err: unknown) => {
      reject(err)
    })

    writeStream.end(data)
  })
}

async function removeRemoteDirectory(conn: Client, path: string): Promise<void> {
  await execCommandAsync(conn, `rm -rf ${path}`)
}

async function readDirRecursiveAsync(sftp: SFTPWrapper, dirPath: string): Promise<File[]> {
  const files: File[] = []

  const entries = await readDirAsync(sftp, dirPath)

  for (const entry of entries) {
    const entryFullPath = posix.join(dirPath, entry.filename)
    const parent = dirPath

    if (isDirectory(entry)) {
      const nestedFiles = await readDirRecursiveAsync(sftp, entryFullPath)
      files.push(...nestedFiles)
    } else if (isFile(entry)) {
      const data = await readFileAsync(sftp, entryFullPath)
      files.push({
        name: entry.filename,
        parentPath: parent,
        path: entryFullPath,
        data,
      })
    }
  }

  return files
}

async function uploadFiles(sshConfig: ConnectConfig, files: File[], path: string): Promise<void> {
  const sftp = await connectSFTP(sshConfig)

  for (const file of files) {
    const remotePath = posix.join(path, file.path.toString())
    const remoteDir = posix.dirname(remotePath)

    await ensureRemoteDirectory(sftp, remoteDir)
    await uploadFile(sftp, file, remotePath)
  }

  sftp.end()
}

async function createSymlink(sshConfig: ConnectConfig, targetPath: string, linkPath: string): Promise<void> {
  const client = await connectSSHClient(sshConfig)
  const sftp = await getSftp(client)

  await ensureRemoteDirectory(sftp, posix.dirname(linkPath))
  await removeRemoteDirectory(client, linkPath)
  await symlinkAsync(sftp, targetPath, linkPath)

  sftp.end()
}

async function downloadFiles(sshConfig: ConnectConfig, path: string): Promise<File[]> {
  const sftp = await connectSFTP(sshConfig)

  if (!(await directoryExists(sftp, path))) return []

  const result: File[] = await readDirRecursiveAsync(sftp, path)

  const files = result.map((file) => ({
    name: file.name,
    parentPath: './' + stripBasePath(file.parentPath, path),
    path: './' + stripBasePath(file.path, path),
    data: file.data,
  }))

  sftp.end()

  return files
}

// ── Inlined server functions ──

const STAGING_BASE = '/var/lib/mirror-state'

function resolveLinkPath(inputs: MirrorStateProviderInputs): string {
  const remotePath = inputs.remotePath.toString()
  if (posix.isAbsolute(remotePath)) {
    return posix.normalize(remotePath)
  }
  return posix.join(`/home/${inputs.connection.user}`, remotePath)
}

async function sendData(inputs: MirrorStateProviderInputs): Promise<string> {
  const currentDate = getCurrentFormattedDate()

  const directory = `${STAGING_BASE}/${currentDate}/`
  const linkPath = resolveLinkPath(inputs)
  const sshConfig = toSsh2ConnectConfig(inputs.connection)

  while (!(await compareStates(await getData(inputs), inputs.files))) {
    await uploadFiles(sshConfig, inputs.files, directory)
    await createSymlink(sshConfig, directory, linkPath)
  }

  return computeMetaHash(inputs.files).toString('hex')
}

async function getData(inputs: MirrorStateProviderInputs): Promise<File[]> {
  const linkPath = resolveLinkPath(inputs)
  const sshConfig = toSsh2ConnectConfig(inputs.connection)
  return await downloadFiles(sshConfig, linkPath)
}

async function removeData(inputs: MirrorStateProviderInputs): Promise<void> {
  const linkPath = resolveLinkPath(inputs)
  const sshConfig = toSsh2ConnectConfig(inputs.connection)
  const client = await connectSSHClient(sshConfig)

  try {
    // Read the symlink target before removing
    const sftp = await getSftp(client)
    let targetPath: string | undefined
    try {
      targetPath = await new Promise<string>((resolve, reject) => {
        sftp.readlink(linkPath, (err, target) => (err ? reject(err) : resolve(target)))
      })
    } catch {
      // Symlink doesn't exist or isn't a symlink — nothing to clean up
    }

    // Remove the symlink
    await removeRemoteDirectory(client, linkPath)

    // Remove the timestamped staging directory
    if (targetPath) {
      await removeRemoteDirectory(client, targetPath)
    }

    sftp.end()
  } catch {
    client.end()
  }
}

// ── Provider ──

export class MirrorStateProvider implements dynamic.ResourceProvider {
  async create(inputs: MirrorStateProviderInputs): Promise<dynamic.CreateResult> {
    const hash = await sendData(inputs)
    return {
      id: `${inputs.connection.user}: ${inputs.remotePath}`,
      outs: { ...inputs, filesHash: hash },
    }
  }

  async update(
    _id: string,
    _olds: MirrorStateProviderInputs,
    news: MirrorStateProviderInputs,
  ): Promise<dynamic.UpdateResult> {
    const hash = await sendData(news)
    return { outs: { ...news, filesHash: hash } }
  }

  async diff(
    _id: string,
    _olds: MirrorStateProviderInputs,
    news: MirrorStateProviderInputs,
  ): Promise<dynamic.DiffResult> {
    try {
      const remoteState = await getData(news)
      return {
        changes: !compareStates(remoteState, news.files),
      }
    } catch (err: unknown) {
      // During preview, Output<string> hosts may not be resolved yet —
      // return no changes so it doesn't force a re-apply
      const error = err as { code?: string; message?: string }
      if (error?.code === 'ENOTFOUND' || error?.message?.includes('ENOTFOUND')) {
        return { changes: false }
      }
      throw err
    }
  }

  async delete(_id: string, props: MirrorStateProviderInputs): Promise<void> {
    await removeData(props)
  }
}

export class MirrorState extends dynamic.Resource {
  constructor(name: string, props: MirrorStateInputs, opts?: CustomResourceOptions) {
    super(new MirrorStateProvider(), name, props, opts)
  }
}
