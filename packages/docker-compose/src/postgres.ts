import * as pulumi from '@pulumi/pulumi'
import * as command from '@pulumi/command'

import type { ConnectionArgs } from './connection'

export interface PostgresDatabaseArgs {
  connection: ConnectionArgs
  role: string
  database?: string
  password: pulumi.Output<string>
  postgresUser?: string
  containerName?: string
}

export function createPostgresDatabase(
  name: string,
  args: PostgresDatabaseArgs,
  opts?: pulumi.CustomResourceOptions,
): command.remote.Command {
  const db = args.database ?? args.role
  const pgUser = args.postgresUser ?? 'postgres'
  const container = args.containerName ?? 'postgres'

  return new command.remote.Command(
    name,
    {
      connection: args.connection,
      create: pulumi.interpolate`docker exec ${container} psql -U ${pgUser} -c "DO \\$\\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${args.role}') THEN CREATE ROLE ${args.role} WITH LOGIN PASSWORD '${args.password}'; ELSE ALTER ROLE ${args.role} WITH PASSWORD '${args.password}'; END IF; END\\$\\$;" && docker exec ${container} createdb -U ${pgUser} -O ${args.role} ${db} 2>/dev/null; docker exec ${container} psql -U ${pgUser} -c "GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${args.role};"`,
    },
    opts,
  )
}
