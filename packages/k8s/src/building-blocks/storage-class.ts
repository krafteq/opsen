import * as pulumi from '@pulumi/pulumi'
import * as _ from 'lodash'
import { StorageClassMeta, StorageClassRequest } from '@opsen/platform'

/**
 * Resolve a `StorageClassRequest` against a list of known storage classes.
 *
 * If the request is a plain string it is returned as-is (an explicit class name).
 * Otherwise the request's label selectors are matched against `storageClasses`.
 */
export function resolveStorageClass(
  request: StorageClassRequest,
  storageClasses: pulumi.Input<pulumi.Input<StorageClassMeta>[]>,
  opts?: { failIfNoMatch: boolean },
): pulumi.Output<string | undefined> {
  if (typeof request == 'string') return pulumi.output(request)

  return pulumi
    .output(storageClasses)
    .apply((x) => pulumi.all(x))
    .apply((all) => {
      const match = all.filter((x) => {
        for (const item of _.entries(request)) {
          if (x.labels[item[0]] != item[1]) return false
        }

        return true
      })

      if (match.length == 0 && opts?.failIfNoMatch == true)
        throw new Error(`storage class for ${JSON.stringify(request)} not found`)

      return match[0]?.name
    })
}
