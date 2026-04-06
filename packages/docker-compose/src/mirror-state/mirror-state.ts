import { dynamic, type CustomResourceOptions } from '@pulumi/pulumi'

import type { MirrorStateProviderInputs, MirrorStateInputs } from './types'
import { sendData, getData, removeData } from './server'
import { compareStates } from './common'

export class MirrorStateProvider implements dynamic.ResourceProvider {
  async create(inputs: MirrorStateProviderInputs): Promise<dynamic.CreateResult> {
    const hash = await sendData(inputs)
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
    const hash = await sendData(news)
    return { outs: { ...news, filesHash: hash } }
  }

  async diff(
    _id: string,
    _olds: MirrorStateProviderInputs,
    news: MirrorStateProviderInputs,
  ): Promise<dynamic.DiffResult> {
    try {
      const remoteState = await getData(news)
      return {
        changes: !compareStates(remoteState, news.files),
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
    await removeData(props)
  }
}

export class MirrorState extends dynamic.Resource {
  constructor(name: string, props: MirrorStateInputs, opts?: CustomResourceOptions) {
    super(new MirrorStateProvider(), name, props, opts)
  }
}
