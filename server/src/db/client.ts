import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

/**
 * Schema is bootstrapped with idempotent DDL on startup — no migration step
 * for self-hosted installs. Keep this in sync with schema.ts.
 */
const BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'shopify',
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes TEXT NOT NULL,
  auth_kind TEXT NOT NULL DEFAULT 'token',
  access_token_encrypted TEXT,
  client_id_encrypted TEXT,
  client_secret_encrypted TEXT,
  token_expires_at TEXT,
  scope_profile TEXT NOT NULL,
  last_synced_at TEXT,
  shop_name TEXT,
  favicon_url TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staging_items (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_title TEXT NOT NULL,
  variant_title TEXT,
  before_url TEXT NOT NULL,
  after_url TEXT NOT NULL,
  action TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image',
  target_position INTEGER NOT NULL,
  target_media_id TEXT,
  source_media_id TEXT,
  prior_media_snapshot TEXT,
  published_media_id TEXT,
  state TEXT NOT NULL,
  recipe_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staging_store ON staging_items(store_id);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  graph TEXT NOT NULL,
  raw_graph TEXT,
  input_node_id TEXT NOT NULL,
  output_node_id TEXT NOT NULL,
  params TEXT NOT NULL,
  fixed_inputs TEXT NOT NULL DEFAULT '[]',
  node_count INTEGER NOT NULL,
  image_asset_id TEXT,
  compare_image_asset_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  params TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target TEXT,
  stage_action TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ui',
  sample INTEGER NOT NULL DEFAULT 0,
  sample_of_total INTEGER,
  retry_of_run_id TEXT,
  state TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_store ON runs(store_id);
CREATE TABLE IF NOT EXISTS mock_catalogs (
  store_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  store_id TEXT,
  item_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_enrichment (
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  caption TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, product_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_enrichment_store ON media_enrichment(store_id);
CREATE TABLE IF NOT EXISTS gallery_arrangements (
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  "order" TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, product_id)
);
`

export function createDb(databasePath: string) {
  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(BOOTSTRAP_DDL)

  const hasColumn = (table: string, column: string): boolean => {
    const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    return columns.some((c) => c.name === column)
  }

  // Additive migration for databases created before the workflows/runs era.
  if (!hasColumn('staging_items', 'run_id')) {
    sqlite.exec('ALTER TABLE staging_items ADD COLUMN run_id TEXT')
  }
  // Additive migration for databases created before multi-output/add-new.
  if (!hasColumn('staging_items', 'media_type')) {
    sqlite.exec(`
      ALTER TABLE staging_items ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';
      ALTER TABLE staging_items ADD COLUMN published_media_id TEXT;
    `)
  }
  // Additive migration for databases created before identity-addressed publish.
  if (!hasColumn('staging_items', 'target_media_id')) {
    sqlite.exec('ALTER TABLE staging_items ADD COLUMN target_media_id TEXT')
  }
  // Additive migration for databases created before source-media provenance.
  if (!hasColumn('staging_items', 'source_media_id')) {
    sqlite.exec('ALTER TABLE staging_items ADD COLUMN source_media_id TEXT')
  }
  // Additive migration for databases created before run-time re-conversion.
  if (!hasColumn('workflows', 'raw_graph')) {
    sqlite.exec('ALTER TABLE workflows ADD COLUMN raw_graph TEXT')
  }
  // Additive migration for databases created before workflow thumbnails.
  if (!hasColumn('workflows', 'image_asset_id')) {
    sqlite.exec('ALTER TABLE workflows ADD COLUMN image_asset_id TEXT')
  }
  // Additive migration for databases created before the hover-wipe compare image.
  if (!hasColumn('workflows', 'compare_image_asset_id')) {
    sqlite.exec('ALTER TABLE workflows ADD COLUMN compare_image_asset_id TEXT')
  }
  // Additive migration for databases created before fixed reference images.
  if (!hasColumn('workflows', 'fixed_inputs')) {
    sqlite.exec("ALTER TABLE workflows ADD COLUMN fixed_inputs TEXT NOT NULL DEFAULT '[]'")
  }
  // Additive migration for databases created before retry-chain grouping.
  if (!hasColumn('runs', 'retry_of_run_id')) {
    sqlite.exec('ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT')
  }
  // Additive migration for databases created before full-target persistence
  // (promote of selection/products targets).
  if (!hasColumn('runs', 'target')) {
    sqlite.exec('ALTER TABLE runs ADD COLUMN target TEXT')
  }
  // Additive migration for databases created before client-credentials auth.
  if (!hasColumn('stores', 'auth_kind')) {
    sqlite.exec(`
      ALTER TABLE stores ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'token';
      ALTER TABLE stores ADD COLUMN client_id_encrypted TEXT;
      ALTER TABLE stores ADD COLUMN client_secret_encrypted TEXT;
      ALTER TABLE stores ADD COLUMN token_expires_at TEXT;
    `)
  }
  // Additive migration for databases created before store name + favicon.
  if (!hasColumn('stores', 'shop_name')) {
    sqlite.exec(`
      ALTER TABLE stores ADD COLUMN shop_name TEXT;
      ALTER TABLE stores ADD COLUMN favicon_url TEXT;
    `)
  }
  return drizzle(sqlite, { schema })
}
