import { posix } from 'node:path'
import type { MirrorStateProviderInputs } from './types'
import { toSsh2ConnectConfig } from '../connection'
import * as common from './common'
import * as sshUtils from './ssh-utils'
import type { File } from './types'

const STAGING_BASE = '/var/lib/mirror-state'

function resolveLinkPath(inputs: MirrorStateProviderInputs): string {
  const remotePath = inputs.remotePath.toString()
  if (posix.isAbsolute(remotePath)) {
    return posix.normalize(remotePath)
  }
  return posix.join(`/home/${inputs.connection.user}`, remotePath)
}

export async function sendData(inputs: MirrorStateProviderInputs): Promise<string> {
  const currentDate = common.getCurrentFormattedDate()

  const directory = `${STAGING_BASE}/${currentDate}/`
  const linkPath = resolveLinkPath(inputs)
  const sshConfig = toSsh2ConnectConfig(inputs.connection)

  while (!(await common.compareStates(await getData(inputs), inputs.files))) {
    await sshUtils.uploadFiles(sshConfig, inputs.files, directory)
    await sshUtils.createSymlink(sshConfig, directory, linkPath)
  }

  return common.computeMetaHash(inputs.files).toString('hex')
}

export async function getData(inputs: MirrorStateProviderInputs): Promise<File[]> {
  const linkPath = resolveLinkPath(inputs)
  const sshConfig = toSsh2ConnectConfig(inputs.connection)
  return await sshUtils.downloadFiles(sshConfig, linkPath)
}

export async function removeData(inputs: MirrorStateProviderInputs): Promise<void> {
  const linkPath = resolveLinkPath(inputs)
  const sshConfig = toSsh2ConnectConfig(inputs.connection)
  const client = await sshUtils.connectSSHClient(sshConfig)

  try {
    // Read the symlink target before removing
    const sftp = await sshUtils.getSftp(client)
    let targetPath: string | undefined
    try {
      targetPath = await new Promise<string>((resolve, reject) => {
        sftp.readlink(linkPath, (err, target) => (err ? reject(err) : resolve(target)))
      })
    } catch {
      // Symlink doesn't exist or isn't a symlink — nothing to clean up
    }

    // Remove the symlink
    await sshUtils.removeRemoteDirectory(client, linkPath)

    // Remove the timestamped staging directory
    if (targetPath) {
      await sshUtils.removeRemoteDirectory(client, targetPath)
    }

    sftp.end()
  } catch {
    client.end()
  }
}
