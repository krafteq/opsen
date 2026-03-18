import type { ConnectConfig } from 'ssh2'

export interface ConnectionArgs {
  host: string
  port?: number
  privateKey: string
  user: string
}

export function toSsh2ConnectConfig(args: ConnectionArgs): ConnectConfig {
  return {
    host: args.host,
    port: args.port,
    username: args.user,
    privateKey: args.privateKey,
  }
}

export function createConnection(host: string, opts: { user: string; privateKey: string }): ConnectionArgs {
  return {
    host,
    user: opts.user,
    privateKey: opts.privateKey,
  }
}
