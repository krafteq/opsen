import type { Input } from '@pulumi/pulumi'
import type { PathLike, WriteFileOptions } from 'node:fs'
import type { ConnectionArgs } from '../connection'

export interface MirrorStateInputs {
  connection: Input<ConnectionArgs>
  files: Input<File[]>
  remotePath: Input<PathLike>
}

export interface MirrorStateProviderInputs {
  connection: ConnectionArgs
  files: File[]
  remotePath: PathLike
}

export interface File {
  name: string
  parentPath: PathLike
  path: PathLike
  data: Buffer
  options?: WriteFileOptions
}
