import type { InfrastructureConfig } from './config'

export interface FactStoreReader {
  read(): Promise<InfrastructureConfig>
}

export interface FactStoreWriter {
  write(config: InfrastructureConfig): Promise<void>
}
