import * as pulumi from '@pulumi/pulumi'

export interface Ingress {
  /** The ingress host i.e. www.example.com. */
  hosts?: pulumi.Input<string[]>
  /** Virtual path of the ingress resource */
  path?: pulumi.Input<string>
  /** Enable acme tls for this ingress. Defaults to true. */
  tls?: pulumi.Input<boolean>
  /** The ingress class. Defaults to 'nginx'. */
  class?: pulumi.Input<string>
  /** Certificate issuer */
  issuer?: pulumi.Input<string>
  /** Redirect non-http requests to https */
  sslRedirect?: pulumi.Input<boolean>
  /** Middleware to protect ingress with OAuth2 authentication */
  auth?: {
    signInUrl: pulumi.Input<string>
    authUrl: pulumi.Input<string>
  }
  /** Any additional annotations */
  annotations?: pulumi.Input<Record<string, pulumi.Input<string>>>
}

export interface Persistence {
  enabled?: pulumi.Input<boolean>
  sizeGB?: number
  storageClass?: pulumi.Input<string | undefined>
  mountPath?: string
}
