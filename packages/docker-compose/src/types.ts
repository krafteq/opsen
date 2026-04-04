import type { Input } from '@pulumi/pulumi'
import type { ConnectionArgs } from './connection'

export interface DockerComposeProjectArgs {
  remotePath: Input<string>
  composeFile: Input<string>
  files?: ComposeFileArgs[]
  environment?: Record<string, Input<string>>
}

export interface ComposeFileArgs {
  path: string
  content: Input<string>
}

export interface DockerComposeArgs {
  connection: ConnectionArgs
  project: DockerComposeProjectArgs
  preCommands?: Input<string>[]
  healthCheck?: Input<string>
}
