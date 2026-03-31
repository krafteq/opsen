import { dynamic, type CustomResourceOptions } from '@pulumi/pulumi'

import type { MirrorStateProviderInputs, MirrorStateInputs } from './types'
// Imported dynamically inside provider methods to avoid capturing module
// references in Pulumi's closure serialization (breaks with pnpm store paths).
type ServerModule = typeof import('./server')
type CommonModule = typeof import('./common')

export class MirrorStateProvider implements dynamic.ResourceProvider {
  async create(inputs: MirrorStateProviderInputs): Promise<dynamic.CreateResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server: ServerModule = require('./server')
    const hash = await server.sendData(inputs)
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server: ServerModule = require('./server')
    const hash = await server.sendData(news)
    return { outs: { ...news, filesHash: hash } }
  }

  async diff(
    _id: string,
    _olds: MirrorStateProviderInputs,
    news: MirrorStateProviderInputs,
  ): Promise<dynamic.DiffResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server: ServerModule = require('./server')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const common: CommonModule = require('./common')
    try {
      const remoteState = await server.getData(news)
      return {
        changes: !common.compareStates(remoteState, news.files),
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server: ServerModule = require('./server')
    await server.removeData(props)
  }
}

export class MirrorState extends dynamic.Resource {
  constructor(name: string, props: MirrorStateInputs, opts?: CustomResourceOptions) {
    super(new MirrorStateProvider(), name, props, opts)
  }
}
