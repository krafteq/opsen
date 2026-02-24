import * as pulumi from '@pulumi/pulumi'
import { Ingress } from '@opsen/platform'

export class HelmHelpers {
  public static ingressValues(ingress: pulumi.Input<Ingress | undefined>, uniquePrefix: string) {
    return pulumi.output(ingress).apply((x: any) => {
      if (x === undefined) {
        return {
          enabled: false,
        }
      }

      return {
        enabled: true,
        ...(x.tls
          ? {
              tls: [
                {
                  secretName: `${uniquePrefix}-tls`,
                  hosts: [...(x.hosts ?? [])],
                },
              ],
            }
          : undefined),
        ...(x.hosts ? { hosts: [...x.hosts] } : undefined),
        ...(x.path ? { path: x.path } : undefined),
        ...(x.class ? { className: x.class } : undefined),
        annotations: {
          ...(x.class ? { 'kubernetes.io/ingress.class': x.class } : undefined),
          ...(x.issuer ? { 'cert-manager.io/cluster-issuer': x.issuer } : undefined),
          ...(x.sslRedirect ? { 'nginx.ingress.kubernetes.io/ssl-redirect': 'true' } : undefined),
          ...(x.auth
            ? {
                'nginx.ingress.kubernetes.io/auth-signin': x.auth.signInUrl,
                'nginx.ingress.kubernetes.io/auth-url': x.auth.authUrl,
              }
            : undefined),
          ...x.annotations,
        },
      }
    })
  }
}
