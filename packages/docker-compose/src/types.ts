import type { Input, Output } from '@pulumi/pulumi'
import type { ConnectionArgs } from './connection'

export interface DockerComposeProjectArgs {
  remotePath: string | Output<string>
  composeFile: string | Output<string>
  files?: ComposeFile[]
  environment?: Record<string, string | Output<string>>
}

export interface ComposeFile {
  path: string
  content: string | Output<string>
}

export interface DockerComposeArgs {
  connection: ConnectionArgs
  project: DockerComposeProjectArgs
  preCommands?: Input<string>[]
  healthCheck?: Input<string>
}
