import * as pulumi from '@pulumi/pulumi'
import * as command from '@pulumi/command'
import type { ConnectionArgs } from './connection'

export interface DnsRecordArgs {
  /** SSH connection to the DNS server */
  connection: ConnectionArgs
  /** PowerDNS API key (secret) */
  apiKey: pulumi.Input<string>
  /** FQDN — used as both zone name and record name (e.g., "vault.example.com") */
  hostname: string
  /** Record type (e.g., "A") */
  type: string
  /** Record value (e.g., IP address) */
  content: pulumi.Input<string>
  /** TTL in seconds (default: 300) */
  ttl?: number
}

// SSHes to the DNS server and curls the PowerDNS API on localhost:8081.
// Creates a per-subdomain zone (idempotent — accepts 201 or 409) then sets the apex A record.
// On delete, removes the entire zone.
export function createInternalDnsRecord(
  resourceName: string,
  args: DnsRecordArgs,
  opts?: pulumi.CustomResourceOptions,
): command.remote.Command {
  const ttl = args.ttl ?? 300
  const zone = args.hostname
  return new command.remote.Command(
    resourceName,
    {
      connection: args.connection,
      create: pulumi.interpolate`HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8081/api/v1/servers/localhost/zones -H "X-API-Key: ${args.apiKey}" -H "Content-Type: application/json" -d '{"name":"${zone}.","kind":"Native","nameservers":[]}') && { [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "409" ]; } && curl -sf -X PATCH http://localhost:8081/api/v1/servers/localhost/zones/${zone}. -H "X-API-Key: ${args.apiKey}" -H "Content-Type: application/json" -d '{"rrsets":[{"name":"${zone}.","type":"${args.type}","ttl":${ttl},"changetype":"REPLACE","records":[{"content":"${args.content}","disabled":false}]}]}'`,
      delete: pulumi.interpolate`curl -s -o /dev/null -X DELETE http://localhost:8081/api/v1/servers/localhost/zones/${zone}. -H "X-API-Key: ${args.apiKey}"`,
    },
    opts,
  )
}
