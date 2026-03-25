import { describe, it, expect } from 'vitest'
import { defaultAzureNaming } from '../naming'
import type { AzureNaming } from '../naming'

describe('defaultAzureNaming', () => {
  it('generates name as deployerName-workloadName-processName', () => {
    const naming = defaultAzureNaming()
    const name = naming.resourceName({
      deployerName: 'cookie-consent',
      workloadName: 'api',
      processName: 'web',
    })
    expect(name).toBe('cookie-consent-api-web')
  })
})

describe('custom AzureNaming', () => {
  it('allows fully custom resource names', () => {
    const naming: AzureNaming = {
      resourceName(ctx) {
        return `myorg-${ctx.deployerName}-${ctx.processName}`
      },
    }
    const name = naming.resourceName({
      deployerName: 'app',
      workloadName: 'api',
      processName: 'web',
    })
    expect(name).toBe('myorg-app-web')
  })
})
