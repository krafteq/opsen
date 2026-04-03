import * as pulumi from '@pulumi/pulumi'
import * as tls from '@pulumi/tls'
import type { PlatformCAArgs, AgentCertArgs, ClientCertArgs } from './types'

export interface PlatformCA {
  certPem: pulumi.Output<string>
  privateKeyPem: pulumi.Output<string>
}

export interface IssuedCert {
  certPem: pulumi.Output<string>
  privateKeyPem: pulumi.Output<string>
}

export function createPlatformCA(name: string, args?: PlatformCAArgs, opts?: pulumi.ResourceOptions): PlatformCA {
  const caKey = new tls.PrivateKey(
    `${name}-ca-key`,
    {
      algorithm: 'ECDSA',
      ecdsaCurve: 'P384',
    },
    opts,
  )

  const caCert = new tls.SelfSignedCert(
    `${name}-ca-cert`,
    {
      privateKeyPem: caKey.privateKeyPem,
      isCaCertificate: true,
      validityPeriodHours: args?.validityHours ?? 87600, // 10 years
      allowedUses: ['cert_signing', 'crl_signing'],
      subject: {
        commonName: args?.commonName ?? 'opsen-platform-ca',
        organization: args?.organization ?? 'opsen',
      },
    },
    opts,
  )

  return {
    certPem: caCert.certPem,
    privateKeyPem: caKey.privateKeyPem,
  }
}

export function issueAgentCert(name: string, args: AgentCertArgs, opts?: pulumi.ResourceOptions): IssuedCert {
  const key = new tls.PrivateKey(
    `${name}-key`,
    {
      algorithm: 'ECDSA',
      ecdsaCurve: 'P256',
    },
    opts,
  )

  const csr = new tls.CertRequest(
    `${name}-csr`,
    {
      privateKeyPem: key.privateKeyPem,
      subject: {
        commonName: args.commonName,
        organization: 'opsen',
      },
      ipAddresses: args.ipAddresses,
      dnsNames: args.dnsNames,
    },
    opts,
  )

  const cert = new tls.LocallySignedCert(
    `${name}-cert`,
    {
      certRequestPem: csr.certRequestPem,
      caPrivateKeyPem: args.caPrivateKeyPem,
      caCertPem: args.caCertPem,
      validityPeriodHours: args.validityHours ?? 8760, // 1 year
      allowedUses: ['digital_signature', 'key_encipherment', 'server_auth'],
    },
    opts,
  )

  return {
    certPem: cert.certPem,
    privateKeyPem: key.privateKeyPem,
  }
}

export function issueClientCert(name: string, args: ClientCertArgs, opts?: pulumi.ResourceOptions): IssuedCert {
  const key = new tls.PrivateKey(
    `${name}-key`,
    {
      algorithm: 'ECDSA',
      ecdsaCurve: 'P256',
    },
    opts,
  )

  const csr = new tls.CertRequest(
    `${name}-csr`,
    {
      privateKeyPem: key.privateKeyPem,
      subject: {
        commonName: args.clientName,
        organization: 'opsen',
        organizationalUnit: 'project',
      },
    },
    opts,
  )

  const cert = new tls.LocallySignedCert(
    `${name}-cert`,
    {
      certRequestPem: csr.certRequestPem,
      caPrivateKeyPem: args.caPrivateKeyPem,
      caCertPem: args.caCertPem,
      validityPeriodHours: args.validityHours ?? 8760, // 1 year
      allowedUses: ['digital_signature', 'key_encipherment', 'client_auth'],
    },
    opts,
  )

  return {
    certPem: cert.certPem,
    privateKeyPem: key.privateKeyPem,
  }
}
