import * as pulumi from '@pulumi/pulumi'

export interface DnsRecord {
  name: string
  type: string
  ttl: number
  records: string[]
}

export interface PowerDnsZoneInputs {
  apiUrl: pulumi.Input<string>
  apiKey: pulumi.Input<string>
  zoneName: string
  kind?: string
  nameservers?: string[]
  records?: DnsRecord[]
}

interface PowerDnsZoneProviderInputs {
  apiUrl: string
  apiKey: string
  zoneName: string
  kind: string
  nameservers: string[]
  records: DnsRecord[]
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

  if (!resp.ok && resp.status !== 404) {
    throw new Error(
      `PowerDNS API ${method} ${url} returned ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    )
  }

  return { status: resp.status, data }
}

function toRRSets(records: DnsRecord[], changetype = 'REPLACE') {
  return records.map((r) => ({
    name: r.name,
    type: r.type,
    ttl: r.ttl,
    changetype,
    records: r.records.map((content) => ({ content, disabled: false })),
  }))
}

const powerDnsZoneProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: PowerDnsZoneProviderInputs) {
    const url = `${inputs.apiUrl}/api/v1/servers/localhost/zones`
    const body: Record<string, unknown> = {
      name: inputs.zoneName,
      kind: inputs.kind,
      nameservers: inputs.nameservers,
    }
    if (inputs.records.length > 0) {
      body.rrsets = toRRSets(inputs.records)
    }

    const { data } = await apiRequest('POST', url, inputs.apiKey, body)
    const zone = data as { id: string }

    return {
      id: zone.id || inputs.zoneName,
      outs: inputs,
    }
  },

  async read(id: string, props: PowerDnsZoneProviderInputs) {
    const url = `${props.apiUrl}/api/v1/servers/localhost/zones/${id}`
    const { status } = await apiRequest('GET', url, props.apiKey)

    if (status === 404) {
      throw new Error(`Zone ${id} not found`)
    }

    return { id, props }
  },

  async update(_id: string, _olds: PowerDnsZoneProviderInputs, news: PowerDnsZoneProviderInputs) {
    const url = `${news.apiUrl}/api/v1/servers/localhost/zones/${_id}`
    const body: Record<string, unknown> = {
      kind: news.kind,
      nameservers: news.nameservers,
    }
    if (news.records.length > 0) {
      body.rrsets = toRRSets(news.records)
    }

    await apiRequest('PATCH', url, news.apiKey, body)

    return { outs: news }
  },

  async delete(id: string, props: PowerDnsZoneProviderInputs) {
    const url = `${props.apiUrl}/api/v1/servers/localhost/zones/${id}`
    const { status } = await apiRequest('DELETE', url, props.apiKey)

    // 404 is fine — zone already gone
    if (status === 404) {
      return
    }
  },
}

export class PowerDnsZone extends pulumi.dynamic.Resource {
  public readonly apiUrl!: pulumi.Output<string>
  public readonly apiKey!: pulumi.Output<string>
  public readonly zoneName!: pulumi.Output<string>
  public readonly kind!: pulumi.Output<string>
  public readonly nameservers!: pulumi.Output<string[]>
  public readonly records!: pulumi.Output<DnsRecord[]>

  constructor(name: string, args: PowerDnsZoneInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      powerDnsZoneProvider,
      name,
      {
        apiUrl: args.apiUrl,
        apiKey: pulumi.secret(args.apiKey),
        zoneName: args.zoneName,
        kind: args.kind ?? 'Native',
        nameservers: args.nameservers ?? [],
        records: args.records ?? [],
      },
      opts,
    )
  }
}
