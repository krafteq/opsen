import * as pulumi from '@pulumi/pulumi'

export interface PlatformResourceSpec {}

export interface PlatformResourceRequest {
  kind: string
  apiVersion: string
  spec?: PlatformResourceSpec
}

export interface PlatformResource {}

export interface PlatformResourceProvider {
  supported: { kind: string; apiVersion: string }[]
  canCreate(request: PlatformResourceRequest): boolean
  create(name: string, request: PlatformResourceRequest): pulumi.Output<PlatformResource>
}
