import * as pulumi from '@pulumi/pulumi'

export class StackReference {
  static stacksPool: Record<string, pulumi.StackReference> = {}

  public static get(name: string) {
    return this.stacksPool[name] ?? (this.stacksPool[name] = new pulumi.StackReference(name, { name }))
  }
}
