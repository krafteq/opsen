import * as pulumi from '@pulumi/pulumi'
import { InfrastructureConfig } from './config'
import { StackReference } from './stack-reference'

export class InfrastructureConfigReader {
  public constructor(private readonly stacks: pulumi.Input<pulumi.Input<string>[]>) {}

  public read(): pulumi.Output<InfrastructureConfig[]> {
    const configs = pulumi
      .output(
        pulumi.output(this.stacks).apply((stacks) =>
          stacks.map((x) =>
            StackReference.get(x)
              .getOutput('config')
              .apply((y) => y as InfrastructureConfig),
          ),
        ),
      )
      .apply((y) => y.filter((x) => x))

    return configs
  }
}
