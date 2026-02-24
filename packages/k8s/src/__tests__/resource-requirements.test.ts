import { describe, it, expect } from 'vitest'
import { parseResourceRequirements } from '../building-blocks/resource-requirements'

describe('parseResourceRequirements', () => {
  it('parses string format', () => {
    const result = parseResourceRequirements('100m/500m,256Mi/1Gi')

    expect(result).toEqual({
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '500m', memory: '1Gi' },
    })
  })

  it('parses object format', () => {
    const result = parseResourceRequirements({
      cpu: '50m/200m',
      memory: '128Mi/512Mi',
    })

    expect(result).toEqual({
      requests: { cpu: '50m', memory: '128Mi' },
      limits: { cpu: '200m', memory: '512Mi' },
    })
  })

  it('handles whole-core values', () => {
    const result = parseResourceRequirements('1/4,2Gi/8Gi')

    expect(result).toEqual({
      requests: { cpu: '1', memory: '2Gi' },
      limits: { cpu: '4', memory: '8Gi' },
    })
  })
})
