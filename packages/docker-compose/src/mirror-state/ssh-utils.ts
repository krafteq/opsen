import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2'
import { posix, join } from 'node:path'
import type { File } from './types'
import * as common from './common'

export async function uploadFiles(sshConfig: ConnectConfig, files: File[], path: string): Promise<void> {
  const sftp = await connectSFTP(sshConfig)

  for (const file of files) {
    const remotePath = join(path, file.path.toString())
    const remoteDir = posix.dirname(remotePath)

    await ensureRemoteDirectory(sftp, remoteDir)
    await uploadFile(sftp, file, remotePath)
  }

  sftp.end()
}

export async function createSymlink(sshConfig: ConnectConfig, targetPath: string, linkPath: string): Promise<void> {
  const client = await connectSSHClient(sshConfig)
  const sftp = await getSftp(client)

  await ensureRemoteDirectory(sftp, posix.dirname(linkPath))
  await removeRemoteDirectory(client, linkPath)
  await symlinkAsync(sftp, targetPath, linkPath)

  sftp.end()
}

export async function downloadFiles(sshConfig: ConnectConfig, path: string): Promise<File[]> {
  const sftp = await connectSFTP(sshConfig)

  if (!(await directoryExists(sftp, path))) return []

  const result: File[] = await readDirRecursiveAsync(sftp, path)

  const files = result.map((file) => ({
    name: file.name,
    parentPath: './' + common.stripBasePath(file.parentPath, path),
    path: './' + common.stripBasePath(file.path, path),
    data: file.data,
  }))

  sftp.end()

  return files
}

export function connectSSHClient(config: ConnectConfig): Promise<Client> {
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

export function getSftp(client: Client): Promise<SFTPWrapper> {
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

export function connectSFTP(config: ConnectConfig): Promise<SFTPWrapper> {
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

export async function readDirRecursiveAsync(sftp: SFTPWrapper, dirPath: string): Promise<File[]> {
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

export async function ensureRemoteDirectory(sftp: SFTPWrapper, dir: string): Promise<void> {
  const segments = dir.split('/').filter(Boolean)
  let current = ''

  for (const segment of segments) {
    current += `/${segment}`

    if (!(await directoryExists(sftp, current))) {
      await mkdirAsync(sftp, current)
    }
  }
}

export async function uploadFile(sftp: SFTPWrapper, file: File, remotePath: string): Promise<void> {
  const data = common.normalizeBuffer(file.data)

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

export async function removeRemoteDirectory(conn: Client, path: string): Promise<void> {
  await execCommandAsync(conn, `rm -rf ${path}`)
}

export function statAsync(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

export function mkdirAsync(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
  })
}

export function symlinkAsync(sftp: SFTPWrapper, targetPath: string, linkPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.symlink(targetPath, linkPath, (err) => (err ? reject(err) : resolve()))
  })
}

export function removeAsync(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
  })
}

export function readDirAsync(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

export function readFileAsync(sftp: SFTPWrapper, filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(filePath, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

export function isDirectory(entry: FileEntryWithStats): boolean {
  return entry.attrs.isDirectory?.() ?? entry.longname.startsWith('d')
}

export function isFile(entry: FileEntryWithStats): boolean {
  return entry.attrs.isFile?.() ?? entry.longname.startsWith('-')
}

export function directoryExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return statAsync(sftp, path).then(
    () => true,
    () => false,
  )
}

export function execCommandAsync(
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
