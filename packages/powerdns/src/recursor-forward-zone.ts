import * as pulumi from '@pulumi/pulumi'

const DEFAULT_FORWARD_SERVERS = ['172.28.0.10:5300']

export interface RecursorForwardZoneInputs {
  apiUrl: pulumi.Input<string>
  apiKey: pulumi.Input<string>
  zoneName: string
  servers?: string[]
  recursionDesired?: boolean
}

interface RecursorForwardZoneProviderInputs {
  apiUrl: string
  apiKey: string
  zoneName: string
  servers: string[]
  recursionDesired: boolean
}

async function apiRequest(
  method: string,
  url: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const resp = await fetch(url, {
    method,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await resp.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }

  if (!resp.ok && resp.status !== 404 && resp.status !== 422) {
    throw new Error(
      `Recursor API ${method} ${url} returned ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    )
  }

  return { status: resp.status, data }
}

const recursorForwardZoneProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: RecursorForwardZoneProviderInputs) {
    const url = `${inputs.apiUrl}/api/v1/servers/localhost/zones`
    const body = {
      name: inputs.zoneName,
      type: 'Zone',
      kind: 'Forwarded',
      servers: inputs.servers,
      recursion_desired: inputs.recursionDesired,
    }

    const { status, data } = await apiRequest('POST', url, inputs.apiKey, body)

    // Zone already exists — delete and recreate to ensure our config is applied
    if (status === 422) {
      const msg = typeof data === 'object' && data !== null ? (data as Record<string, string>).error : ''
      if (msg.includes('already exists')) {
        const deleteUrl = `${inputs.apiUrl}/api/v1/servers/localhost/zones/${inputs.zoneName}`
        await apiRequest('DELETE', deleteUrl, inputs.apiKey)
        await apiRequest('POST', url, inputs.apiKey, body)
      }
    }

    return {
      id: inputs.zoneName,
      outs: inputs,
    }
  },

  async read(id: string, props: RecursorForwardZoneProviderInputs) {
    const url = `${props.apiUrl}/api/v1/servers/localhost/zones/${id}`
    const { status } = await apiRequest('GET', url, props.apiKey)

    if (status === 404) {
      throw new Error(`Forward zone ${id} not found`)
    }

    return { id, props }
  },

  async update(id: string, olds: RecursorForwardZoneProviderInputs, news: RecursorForwardZoneProviderInputs) {
    // Recursor API has no PATCH for forward zones — delete + recreate
    const deleteUrl = `${olds.apiUrl}/api/v1/servers/localhost/zones/${id}`
    await apiRequest('DELETE', deleteUrl, olds.apiKey)

    const createUrl = `${news.apiUrl}/api/v1/servers/localhost/zones`
    const body = {
      name: news.zoneName,
      type: 'Zone',
      kind: 'Forwarded',
      servers: news.servers,
      recursion_desired: news.recursionDesired,
    }

    await apiRequest('POST', createUrl, news.apiKey, body)

    return { outs: news }
  },

  async delete(id: string, props: RecursorForwardZoneProviderInputs) {
    const url = `${props.apiUrl}/api/v1/servers/localhost/zones/${id}`
    const { status } = await apiRequest('DELETE', url, props.apiKey)

    // 404 is fine — zone already gone
    if (status === 404) {
      return
    }
  },
}

export class RecursorForwardZone extends pulumi.dynamic.Resource {
  public readonly apiUrl!: pulumi.Output<string>
  public readonly apiKey!: pulumi.Output<string>
  public readonly zoneName!: pulumi.Output<string>
  public readonly servers!: pulumi.Output<string[]>
  public readonly recursionDesired!: pulumi.Output<boolean>

  constructor(name: string, args: RecursorForwardZoneInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      recursorForwardZoneProvider,
      name,
      {
        apiUrl: args.apiUrl,
        apiKey: pulumi.secret(args.apiKey),
        zoneName: args.zoneName,
        servers: args.servers ?? DEFAULT_FORWARD_SERVERS,
        recursionDesired: args.recursionDesired ?? true,
      },
      opts,
    )
  }
}
