import type { ConnectorRegistry } from './connectors/index.js'
import type { Db } from './db/client.js'
import type { Env } from './env.js'
import type { ProviderRegistry } from './providers/index.js'
import type { AssetStore } from './services/assetStore.js'
import type { Audit } from './services/audit.js'
import type { ComfyAuthService } from './services/comfyAuthService.js'
import type { EnrichmentService } from './services/enrichmentService.js'
import type { RunService } from './services/runService.js'
import type { SettingsService } from './services/settingsService.js'
import type { StagingService } from './services/stagingService.js'
import type { StoreService } from './services/storeService.js'
import type { WorkflowService } from './workflows/service.js'

export interface AppContext {
  env: Env
  db: Db
  audit: Audit
  assetStore: AssetStore
  connectors: ConnectorRegistry
  providers: ProviderRegistry
  enrichmentService: EnrichmentService
  settingsService: SettingsService
  comfyAuth: ComfyAuthService
  storeService: StoreService
  stagingService: StagingService
  workflowService: WorkflowService
  runService: RunService
}
