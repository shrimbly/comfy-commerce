import { sql } from 'drizzle-orm'
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),
  connectorId: text('connector_id').notNull().default('shopify'),
  /** 'mock' (demo catalog, no Shopify calls) or 'shopify' (real Admin API). */
  adapter: text('adapter', { enum: ['mock', 'shopify'] }).notNull(),
  status: text('status', { enum: ['connected', 'connecting', 'error'] }).notNull(),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
  /**
   * 'token': static Admin token (legacy custom app shpat_… or OAuth offline).
   * 'client-credentials': Dev Dashboard app — 24h tokens auto-refreshed from
   * the encrypted client ID/secret.
   */
  authKind: text('auth_kind', { enum: ['token', 'client-credentials'] })
    .notNull()
    .default('token'),
  accessTokenEncrypted: text('access_token_encrypted'),
  clientIdEncrypted: text('client_id_encrypted'),
  clientSecretEncrypted: text('client_secret_encrypted'),
  /** ISO timestamp after which the access token must be re-exchanged. */
  tokenExpiresAt: text('token_expires_at'),
  scopeProfile: text('scope_profile', { mode: 'json' })
    .$type<import('@comfy-commerce/shared').ScopeProfile>()
    .notNull(),
  lastSyncedAt: text('last_synced_at'),
  /** Store name + storefront favicon (best-effort, for display). */
  shopName: text('shop_name'),
  faviconUrl: text('favicon_url'),
  createdAt: text('created_at').notNull(),
})

export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  shop: text('shop').notNull(),
  createdAt: text('created_at').notNull(),
})

export const stagingItems = sqliteTable('staging_items', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  productId: text('product_id').notNull(),
  productTitle: text('product_title').notNull(),
  variantTitle: text('variant_title'),
  beforeUrl: text('before_url').notNull(),
  afterUrl: text('after_url').notNull(),
  action: text('action', { enum: ['add-featured', 'replace-position', 'add-new'] }).notNull(),
  mediaType: text('media_type', { enum: ['image', 'video', 'model3d'] }).notNull().default('image'),
  targetPosition: integer('target_position').notNull(),
  /** Media id this item addresses (deleted by a replace publish). Null on legacy rows. */
  targetMediaId: text('target_media_id'),
  /** Media the workflow/API ran on — immutable provenance. Null on legacy rows. */
  sourceMediaId: text('source_media_id'),
  priorMediaSnapshot: text('prior_media_snapshot', { mode: 'json' })
    .$type<import('@comfy-commerce/shared').MediaItem | null>(),
  publishedMediaId: text('published_media_id'),
  state: text('state', {
    enum: ['pending', 'approved', 'publishing', 'published', 'rejected', 'failed'],
  }).notNull(),
  recipeId: text('recipe_id'),
  runId: text('run_id'),
  source: text('source', { enum: ['ui', 'api'] }).notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  graph: text('graph', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** Original upload, kept for editor-format files — re-converted at run time. */
  rawGraph: text('raw_graph', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  inputNodeId: text('input_node_id').notNull(),
  outputNodeId: text('output_node_id').notNull(),
  params: text('params', { mode: 'json' })
    .$type<import('@comfy-commerce/shared').WorkflowParam[]>()
    .notNull(),
  /** Constant reference images bound at upload, keyed by graph node. */
  fixedInputs: text('fixed_inputs', { mode: 'json' })
    .$type<import('@comfy-commerce/shared').FixedInput[]>()
    .notNull()
    .default(sql`'[]'`),
  nodeCount: integer('node_count').notNull(),
  imageAssetId: text('image_asset_id'),
  compareImageAssetId: text('compare_image_asset_id'),
  createdAt: text('created_at').notNull(),
})

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  workflowId: text('workflow_id').notNull(),
  workflowName: text('workflow_name').notNull(),
  providerId: text('provider_id').notNull(),
  params: text('params', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  targetKind: text('target_kind', { enum: ['selection', 'products', 'catalog'] }).notNull(),
  /** Full target as submitted — promote() re-expands from it. Null on legacy rows. */
  target: text('target', { mode: 'json' }).$type<import('@comfy-commerce/shared').RunTarget | null>(),
  stageAction: text('stage_action', {
    enum: ['add-featured', 'replace-position', 'add-new'],
  }).notNull(),
  source: text('source', { enum: ['ui', 'api'] }).notNull().default('ui'),
  sample: integer('sample', { mode: 'boolean' }).notNull().default(false),
  sampleOfTotal: integer('sample_of_total'),
  retryOfRunId: text('retry_of_run_id'),
  state: text('state', {
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
  }).notNull(),
  cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
  items: text('items', { mode: 'json' })
    .$type<import('@comfy-commerce/shared').RunItem[]>()
    .notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const mockCatalogs = sqliteTable('mock_catalogs', {
  storeId: text('store_id').primaryKey(),
  data: text('data', { mode: 'json' })
    .$type<{
      collections: import('@comfy-commerce/shared').Collection[]
      products: import('@comfy-commerce/shared').Product[]
    }>()
    .notNull(),
})

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  ts: text('ts').notNull(),
  storeId: text('store_id'),
  itemId: text('item_id'),
  action: text('action').notNull(),
  detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
})

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  contentType: text('content_type').notNull(),
  filename: text('filename').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * Global app settings as a singleton key-value store. Holds operator-set config
 * that isn't per-store and shouldn't require a restart to change — e.g. the
 * Remote ComfyUI engine URL set from the Connectors page.
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/** Reusable prompt library — first-class, shared across workflows and runs. */
export const prompts = sqliteTable('prompts', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** AI caption + tags per product image (catalog enrichment), keyed per media. */
export const mediaEnrichment = sqliteTable(
  'media_enrichment',
  {
    storeId: text('store_id').notNull(),
    productId: text('product_id').notNull(),
    mediaId: text('media_id').notNull(),
    caption: text('caption'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    /** Engine/model that produced it, e.g. "Qwen2.5-VL-3B-Instruct". */
    model: text('model').notNull().default(''),
    source: text('source', { enum: ['ai', 'manual'] }).notNull().default('ai'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.storeId, t.productId, t.mediaId] }) }),
)

/** Per-product full-gallery order set on the Review Approved tab, enforced on publish. */
export const galleryArrangements = sqliteTable(
  'gallery_arrangements',
  {
    storeId: text('store_id').notNull(),
    productId: text('product_id').notNull(),
    order: text('order', { mode: 'json' })
      .$type<import('@comfy-commerce/shared').GallerySlotRef[]>()
      .notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.storeId, t.productId] }) }),
)
