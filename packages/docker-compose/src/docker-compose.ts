import * as pulumi from '@pulumi/pulumi'
import * as command from '@pulumi/command'

import type { DockerComposeArgs } from './types'
import { MirrorState } from './mirror-state'
import type { File } from './mirror-state/types'

function buildMirrorFiles(
  _remotePath: string,
  composeContent: string,
  files?: { path: string; content: string }[],
  environment?: Record<string, string>,
): File[] {
  const mirrorFiles: File[] = [
    {
      name: 'docker-compose.yml',
      parentPath: './',
      path: './docker-compose.yml',
      data: Buffer.from(composeContent),
    },
  ]

  if (files) {
    for (const f of files) {
      mirrorFiles.push({
        name: f.path.split('/').pop() || f.path,
        parentPath: './' + (f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : ''),
        path: './' + f.path,
        data: Buffer.from(f.content),
      })
    }
  }

  if (environment && Object.keys(environment).length > 0) {
    const envContent =
      Object.entries(environment)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n'
    mirrorFiles.push({
      name: '.env',
      parentPath: './',
      path: './.env',
      data: Buffer.from(envContent),
    })
  }

  return mirrorFiles
}

export class DockerCompose extends pulumi.ComponentResource {
  public readonly composePath: pulumi.Output<string>

  constructor(name: string, args: DockerComposeArgs, opts?: pulumi.ComponentResourceOptions) {
    super('custom:docker:DockerCompose', name, {}, opts)

    const { connection, project, preCommands, healthCheck } = args

    // Auto-generated setup commands
    const setupMirror = new command.remote.Command(
      `${name}-setup-mirror`,
      {
        connection,
        create: `sudo mkdir -p /var/lib/mirror-state && sudo chown ${connection.user}:${connection.user} /var/lib/mirror-state`,
      },
      { parent: this },
    )

    const setupProject = new command.remote.Command(
      `${name}-setup-project`,
      {
        connection,
        create: pulumi.interpolate`sudo mkdir -p ${project.remotePath} ${project.remotePath}/compose && sudo chown ${connection.user}:${connection.user} ${project.remotePath} ${project.remotePath}/compose`,
      },
      { parent: this, dependsOn: [setupMirror] },
    )

    // User pre-commands
    const preCommandResources: command.remote.Command[] = []
    if (preCommands) {
      for (let i = 0; i < preCommands.length; i++) {
        const cmd = new command.remote.Command(
          `${name}-pre-${i}`,
          {
            connection,
            create: preCommands[i],
          },
          { parent: this, dependsOn: i > 0 ? [preCommandResources[i - 1]] : [setupProject] },
        )
        preCommandResources.push(cmd)
      }
    }

    // Resolve all Outputs and build mirror files
    const mirrorFiles = pulumi
      .all([
        project.remotePath,
        project.composeFile,
        ...(project.files ?? []).map((f) => f.content),
        ...Object.values(project.environment ?? {}),
      ])
      .apply(([remotePath, composeContent, ...rest]) => {
        const fileContents = rest.slice(0, project.files?.length ?? 0) as string[]
        const envValues = rest.slice(project.files?.length ?? 0) as string[]

        const resolvedFiles = project.files?.map((f, i) => ({
          path: f.path,
          content: fileContents[i],
        }))

        const envKeys = Object.keys(project.environment ?? {})
        const resolvedEnv: Record<string, string> = {}
        envKeys.forEach((k, i) => {
          resolvedEnv[k] = envValues[i]
        })

        return buildMirrorFiles(
          remotePath as string,
          composeContent as string,
          resolvedFiles,
          Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
        )
      })

    const composePath = pulumi.output(project.remotePath).apply((p) => `${p}/compose`)

    // MirrorState — sync files to ${remotePath}/compose/
    const lastPreStep =
      preCommandResources.length > 0 ? preCommandResources[preCommandResources.length - 1] : setupProject
    const mirror = new MirrorState(
      `${name}-mirror`,
      {
        connection,
        files: mirrorFiles,
        remotePath: composePath,
      },
      {
        parent: this,
        dependsOn: [lastPreStep],
        customTimeouts: { create: '1m' },
      },
    )

    // Compose up — delete is a no-op because triggers cause REPLACEMENT and
    // deleteBeforeReplace runs delete on every file change. compose down would
    // kill ALL containers (including unchanged ones). docker compose up
    // --remove-orphans handles the full lifecycle instead.
    const composeUp = new command.remote.Command(
      `${name}-compose-up`,
      {
        connection,
        create: pulumi.interpolate`cd ${composePath} && docker compose up -d --wait --build --remove-orphans`,
        delete: "echo 'compose lifecycle managed by docker compose up'",
        triggers: [mirrorFiles],
      },
      { parent: this, dependsOn: [mirror], deleteBeforeReplace: true },
    )

    // Health check
    if (healthCheck) {
      new command.remote.Command(
        `${name}-health-check`,
        {
          connection,
          create: healthCheck,
        },
        { parent: this, dependsOn: [composeUp] },
      )
    }

    this.composePath = composePath
    this.registerOutputs({ composePath })
  }
}
