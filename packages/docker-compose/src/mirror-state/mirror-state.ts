import { dynamic, type CustomResourceOptions } from '@pulumi/pulumi'

import type { MirrorStateProviderInputs, MirrorStateInputs } from './types'
type ServerModule = typeof import('./server')
type CommonModule = typeof import('./common')

// Resolve absolute paths at module load time so they survive Pulumi's closure
// serialization. The dynamic provider runs plain Node.js (no tsx), so paths must
// point to compiled .js files in dist/. When loaded via tsx from src/, remap accordingly.
function resolveForDynamicProvider(relativePath: string): string {
   
  let resolved = require.resolve(relativePath)
  resolved = resolved.replace(/\.ts$/, '.js').replace(/\/src\//, '/dist/')
  return resolved
}
const serverPath = resolveForDynamicProvider('./server')
const commonPath = resolveForDynamicProvider('./common')

export class MirrorStateProvider implements dynamic.ResourceProvider {
  async create(inputs: MirrorStateProviderInputs): Promise<dynamic.CreateResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server: ServerModule = require(serverPath)
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
    const server: ServerModule = require(serverPath)
    const hash = await server.sendData(news)
    return { outs: { ...news, filesHash: hash } }
  }

  async diff(
    _id: string,
    _olds: MirrorStateProviderInputs,
    news: MirrorStateProviderInputs,
  ): Promise<dynamic.DiffResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server: ServerModule = require(serverPath)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const common: CommonModule = require(commonPath)
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
    const server: ServerModule = require(serverPath)
    await server.removeData(props)
  }
}

export class MirrorState extends dynamic.Resource {
  constructor(name: string, props: MirrorStateInputs, opts?: CustomResourceOptions) {
    super(new MirrorStateProvider(), name, props, opts)
  }
}
