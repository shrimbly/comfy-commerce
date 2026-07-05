import type {
  Collection,
  MediaItem,
  Product,
  ProductStatus,
  StagedMediaType,
} from '@comfy-commerce/shared'

import { fetchWithTimeout } from '../../http.js'
import type {
  AddMediaParams,
  ReplaceMediaParams,
  RestoreMediaParams,
  StoreConnector,
  StoreRecord,
} from '../types.js'
import { shopifyGraphql } from './graphql.js'

/**
 * Real Shopify adapter (Admin GraphQL API).
 *
 * Replace-in-place is not atomic on Shopify, so publish is implemented as:
 * snapshot prior media (done by the staging service) → create new media from
 * URL → await readiness (media ingestion is async) → reorder to the target
 * position → delete the old media. Revert re-creates from the snapshot.
 */

interface MediaNode {
  id: string
  /** Shopify Media-interface discriminator: IMAGE | VIDEO | MODEL_3D | EXTERNAL_VIDEO. */
  mediaContentType: string
  alt: string | null
  image: { url: string; altText: string | null } | null
  /** Present for Video / Model3d: the downloadable source variants. */
  sources: Array<{ url: string; format: string | null }> | null
}

/** Map a Shopify media node to a MediaItem, or null for empty/unsupported media. */
function mediaItemFromNode(n: Partial<MediaNode> & { id?: string }): MediaItem | null {
  if (!n.id) return null
  const altText = n.alt ?? ''
  if (n.mediaContentType === 'VIDEO') {
    const src = n.sources?.find((s) => s.format === 'mp4') ?? n.sources?.[0]
    return src ? { id: n.id, url: src.url, altText, position: 0, mediaType: 'video' } : null
  }
  if (n.mediaContentType === 'MODEL_3D') {
    // model-viewer renders GLB; usdz is AR-only, so prefer the glb source.
    const src = n.sources?.find((s) => s.format === 'glb') ?? n.sources?.[0]
    return src ? { id: n.id, url: src.url, altText, position: 0, mediaType: 'model3d' } : null
  }
  return n.image
    ? { id: n.id, url: n.image.url, altText: altText || (n.image.altText ?? ''), position: 0, mediaType: 'image' }
    : null
}

interface ProductNode {
  id: string
  title: string
  status: string
  tags: string[]
  collections: { edges: Array<{ node: { id: string } }> }
  media: { edges: Array<{ node: Partial<MediaNode> & { id?: string } }> }
  variants: { edges: Array<{ node: { id: string; title: string } }> }
}

const PRODUCT_FIELDS = `
  id
  title
  status
  tags
  collections(first: 20) { edges { node { id } } }
  media(first: 50) {
    edges {
      node {
        id
        mediaContentType
        alt
        ... on MediaImage { image { url altText } }
        ... on Video { sources { url format } }
        ... on Model3d { sources { url format } }
      }
    }
  }
  variants(first: 50) { edges { node { id title } } }
`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Deadlines for the non-GraphQL HTTP hops of a publish. The broker-local
// asset read is LAN-fast; the staged-upload POST ships whole video files to
// Shopify's bucket and gets a much longer leash. Neither retries — the upload
// target is single-use.
const LOCAL_ASSET_TIMEOUT_MS = 60_000
const STAGED_UPLOAD_TIMEOUT_MS = 120_000

/** Throw a single readable error if a Shopify mutation returned user errors. */
function throwOnUserErrors(mutation: string, errors: Array<{ message: string }>): void {
  if (errors.length) throw new Error(`${mutation}: ${errors.map((e) => e.message).join('; ')}`)
}

export interface MediaReadyTimeouts {
  mediaReadyTimeoutMs: number
  mediaReadyVideoTimeoutMs: number
}

/**
 * Readiness-poll ceiling for a media type. Image ingestion is quick; video
 * transcoding and 3D model optimization on Shopify can take minutes, so both
 * get a much longer ceiling.
 */
export function readyTimeoutFor(
  mediaType: StagedMediaType,
  timeouts: MediaReadyTimeouts,
): number {
  return mediaType === 'image' ? timeouts.mediaReadyTimeoutMs : timeouts.mediaReadyVideoTimeoutMs
}

export class RealShopifyConnector implements StoreConnector {
  constructor(
    private opts: {
      apiVersion: string
      /** Public URL of this broker — used to detect broker-local asset URLs. */
      appUrl: string
      /** Readiness ceilings for image/video media ingestion. */
      mediaReadyTimeoutMs: number
      mediaReadyVideoTimeoutMs: number
      /**
       * Resolves a live access token — token custody stays in the broker.
       * May refresh (client-credentials stores), hence async.
       */
      getAccessToken: (store: StoreRecord) => string | Promise<string>
    },
  ) {}

  private async gql<T>(store: StoreRecord, query: string, variables?: Record<string, unknown>) {
    return shopifyGraphql<T>({
      shop: store.domain,
      accessToken: await this.opts.getAccessToken(store),
      apiVersion: this.opts.apiVersion,
      query,
      variables,
    })
  }

  private toProduct(node: ProductNode): Product {
    const media: MediaItem[] = node.media.edges
      .map((e) => mediaItemFromNode(e.node))
      .filter((m): m is MediaItem => m !== null)
      .map((m, i) => ({ ...m, position: i + 1 }))
    return {
      id: node.id,
      title: node.title,
      status: node.status.toLowerCase() as ProductStatus,
      collectionIds: node.collections.edges.map((e) => e.node.id),
      tags: node.tags,
      media,
      variants: node.variants.edges.map((e) => e.node),
    }
  }

  async listCollections(store: StoreRecord): Promise<Collection[]> {
    const data = await this.gql<{
      collections: { edges: Array<{ node: { id: string; title: string } }> }
    }>(store, `{ collections(first: 100) { edges { node { id title } } } }`)
    return data.collections.edges.map((e) => e.node)
  }

  async listProducts(store: StoreRecord): Promise<Product[]> {
    const products: Product[] = []
    let cursor: string | null = null
    for (;;) {
      const data: {
        products: {
          edges: Array<{ cursor: string; node: ProductNode }>
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } = await this.gql(
        store,
        `query Products($cursor: String) {
          products(first: 50, after: $cursor) {
            edges { cursor node { ${PRODUCT_FIELDS} } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { cursor },
      )
      products.push(...data.products.edges.map((e) => this.toProduct(e.node)))
      if (!data.products.pageInfo.hasNextPage) break
      cursor = data.products.pageInfo.endCursor
    }
    return products
  }

  async getProduct(store: StoreRecord, productId: string): Promise<Product | null> {
    const data = await this.gql<{ product: ProductNode | null }>(
      store,
      `query Product($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
      { id: productId },
    )
    return data.product ? this.toProduct(data.product) : null
  }

  /** Resolve one media BY ID with its current position — null when gone. */
  async snapshotMedia(
    store: StoreRecord,
    productId: string,
    mediaId: string,
  ): Promise<MediaItem | null> {
    const product = await this.getProduct(store, productId)
    return product?.media.find((m) => m.id === mediaId) ?? null
  }

  /**
   * Shopify must fetch `originalSource` itself, and the broker's asset URLs
   * are usually not publicly reachable (localhost, LAN). Broker-local images
   * are therefore pushed to Shopify via staged uploads: stagedUploadsCreate →
   * multipart POST of the bytes → use the returned resourceUrl as the source.
   * Public URLs (e.g. Shopify CDN snapshots) pass through untouched.
   */
  private async resolveOriginalSource(
    store: StoreRecord,
    url: string,
    mediaType: StagedMediaType = 'image',
  ): Promise<string> {
    if (!url.startsWith(`${this.opts.appUrl}/`) && !url.startsWith('/')) return url

    const res = await fetchWithTimeout(url.startsWith('/') ? `${this.opts.appUrl}${url}` : url, {
      timeoutMs: LOCAL_ASSET_TIMEOUT_MS,
    })
    if (!res.ok) throw new Error(`Could not read local asset for upload (${res.status})`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const fallback =
      mediaType === 'video'
        ? 'video/mp4'
        : mediaType === 'model3d'
          ? 'model/gltf-binary'
          : 'image/png'
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? fallback
    const ext =
      {
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/quicktime': 'mov',
        'model/gltf-binary': 'glb',
        'model/vnd.usdz+zip': 'usdz',
      }[mimeType] ?? 'png'
    const filename = `comfy-commerce-${Date.now()}.${ext}`

    const data = await this.gql<{
      stagedUploadsCreate: {
        stagedTargets: Array<{
          url: string
          resourceUrl: string
          parameters: Array<{ name: string; value: string }>
        }>
        userErrors: Array<{ message: string }>
      }
    }>(
      store,
      `mutation StagedUploads($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { message }
        }
      }`,
      {
        input: [
          {
            filename,
            mimeType,
            httpMethod: 'POST',
            resource:
              mediaType === 'video' ? 'VIDEO' : mediaType === 'model3d' ? 'MODEL_3D' : 'PRODUCT_IMAGE',
            // Required for VIDEO and MODEL_3D; harmless for images.
            fileSize: String(bytes.length),
          },
        ],
      },
    )
    throwOnUserErrors('stagedUploadsCreate', data.stagedUploadsCreate.userErrors)
    const target = data.stagedUploadsCreate.stagedTargets[0]
    if (!target) throw new Error('stagedUploadsCreate returned no target')

    // Multipart upload: auth parameters first, the file field last.
    const form = new FormData()
    for (const param of target.parameters) form.append(param.name, param.value)
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)
    const upload = await fetchWithTimeout(target.url, {
      method: 'POST',
      body: form,
      timeoutMs: STAGED_UPLOAD_TIMEOUT_MS,
    })
    if (!upload.ok && upload.status !== 201) {
      throw new Error(`Staged upload failed: ${upload.status} ${await upload.text()}`)
    }
    return target.resourceUrl
  }

  /** Current ingestion status of a media node — READY | PROCESSING | FAILED, or null when the node is gone. */
  private async mediaStatus(store: StoreRecord, mediaId: string): Promise<string | null> {
    const data = await this.gql<{ node: { id: string; status: string } | null }>(
      store,
      `query MediaStatus($id: ID!) { node(id: $id) { ... on Media { id status } } }`,
      { id: mediaId },
    )
    return data.node?.status ?? null
  }

  /**
   * Poll a media node until READY. FAILED throws; on timeout the half-ingested
   * node is best-effort deleted (so a slow transcode doesn't orphan media on
   * the product) and the poll throws.
   */
  private async awaitMediaReady(
    store: StoreRecord,
    productId: string,
    mediaId: string,
    mediaType: StagedMediaType,
  ): Promise<void> {
    // Media ingestion is asynchronous: PROCESSING → READY | FAILED. The ceiling
    // depends on media type — video transcoding is far slower than images.
    const ceilingMs = readyTimeoutFor(mediaType, this.opts)
    const deadline = Date.now() + ceilingMs
    while (Date.now() < deadline) {
      const status = await this.mediaStatus(store, mediaId)
      if (status === 'READY') return
      if (status === 'FAILED') throw new Error('Shopify failed to ingest the new media')
      await sleep(1000)
    }
    await this.deleteMedia(store, productId, mediaId).catch(() => {})
    throw new Error(
      `Timed out after ${Math.round(ceilingMs / 1000)}s waiting for media to become READY`,
    )
  }

  /**
   * Create media from a URL and wait until Shopify finishes ingesting it.
   * `onCreated` fires the moment creation is acknowledged — BEFORE the
   * (potentially minutes-long) readiness poll — so a crash mid-poll still
   * leaves the created media id recorded in the caller's ledger.
   */
  private async createMediaAndAwaitReady(
    store: StoreRecord,
    productId: string,
    url: string,
    altText: string,
    mediaType: StagedMediaType = 'image',
    onCreated?: (mediaId: string) => void | Promise<void>,
  ): Promise<string> {
    const source = await this.resolveOriginalSource(store, url, mediaType)
    const created = await this.gql<{
      productCreateMedia: {
        media: Array<{ id: string; status: string }>
        mediaUserErrors: Array<{ field: string[] | null; message: string }>
      }
    }>(
      store,
      `mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on Media { id status } }
          mediaUserErrors { field message }
        }
      }`,
      {
        productId,
        media: [
          {
            originalSource: source,
            alt: altText,
            mediaContentType:
              mediaType === 'video' ? 'VIDEO' : mediaType === 'model3d' ? 'MODEL_3D' : 'IMAGE',
          },
        ],
      },
    )
    throwOnUserErrors('productCreateMedia', created.productCreateMedia.mediaUserErrors)
    const mediaId = created.productCreateMedia.media[0]?.id
    if (!mediaId) throw new Error('productCreateMedia returned no media')
    await onCreated?.(mediaId)
    await this.awaitMediaReady(store, productId, mediaId, mediaType)
    return mediaId
  }

  private async moveMedia(
    store: StoreRecord,
    productId: string,
    mediaId: string,
    targetPosition: number,
  ): Promise<void> {
    const data = await this.gql<{
      productReorderMedia: {
        mediaUserErrors: Array<{ message: string }>
      }
    }>(
      store,
      `mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          mediaUserErrors { message }
        }
      }`,
      { id: productId, moves: [{ id: mediaId, newPosition: String(targetPosition - 1) }] },
    )
    throwOnUserErrors('productReorderMedia', data.productReorderMedia.mediaUserErrors)
  }

  /** Force the listed media to positions 1..N in order (single batched reorder). */
  async reorderMedia(store: StoreRecord, productId: string, orderedMediaIds: string[]): Promise<void> {
    if (orderedMediaIds.length === 0) return
    const data = await this.gql<{
      productReorderMedia: { mediaUserErrors: Array<{ message: string }> }
    }>(
      store,
      `mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          mediaUserErrors { message }
        }
      }`,
      { id: productId, moves: orderedMediaIds.map((id, i) => ({ id, newPosition: String(i) })) },
    )
    throwOnUserErrors('productReorderMedia', data.productReorderMedia.mediaUserErrors)
  }

  private async deleteMedia(store: StoreRecord, productId: string, mediaId: string): Promise<void> {
    const data = await this.gql<{
      productDeleteMedia: { mediaUserErrors: Array<{ message: string }> }
    }>(
      store,
      `mutation Delete($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          mediaUserErrors { message }
        }
      }`,
      { productId, mediaIds: [mediaId] },
    )
    throwOnUserErrors('productDeleteMedia', data.productDeleteMedia.mediaUserErrors)
  }

  /**
   * Resume a previously created media (from a failed/interrupted attempt):
   * READY ⇒ reuse; PROCESSING ⇒ await readiness then reuse; FAILED or gone ⇒
   * null (caller creates fresh). Never creates a second copy of tracked media.
   */
  private async resumeCreatedMedia(
    store: StoreRecord,
    productId: string,
    createdMediaId: string | null | undefined,
    mediaType: StagedMediaType,
  ): Promise<string | null> {
    if (!createdMediaId) return null
    const status = await this.mediaStatus(store, createdMediaId)
    if (status === 'READY') return createdMediaId
    if (status === 'PROCESSING') {
      await this.awaitMediaReady(store, productId, createdMediaId, mediaType)
      return createdMediaId
    }
    return null // FAILED or deleted — treat as absent
  }

  /**
   * Id-addressed, create-before-delete, resumable replace:
   * 1. resume `createdMediaId` if a previous attempt already created the media;
   * 2. fail fast when the target is gone AND there is nothing to resume —
   *    the item must be re-staged, never degraded to an unrevertable add;
   * 3. otherwise create the new media (onCreated fires before the readiness poll);
   * 4. re-resolve the target BY ID (its position may have shifted during the
   *    readiness window), move the new media to its current slot, delete it by id;
   *    target gone on resume ⇒ nothing to move/delete — succeed.
   * No cleanup-on-failure delete: a move/delete failure leaves the created media
   * on-store but TRACKED (via onCreated) — the retry resumes instead of re-creating.
   */
  async replaceMedia(store: StoreRecord, params: ReplaceMediaParams): Promise<{ mediaId: string }> {
    let target = await this.snapshotMedia(store, params.productId, params.targetMediaId)
    let newMediaId = await this.resumeCreatedMedia(
      store,
      params.productId,
      params.createdMediaId,
      params.mediaType,
    )
    if (!newMediaId && !target) {
      throw new Error(
        'Target media no longer exists on the store — re-stage this item against the current catalog',
      )
    }
    if (!newMediaId) {
      newMediaId = await this.createMediaAndAwaitReady(
        store,
        params.productId,
        params.newUrl,
        params.altText,
        params.mediaType,
        params.onCreated,
      )
    }
    // Fresh position after the readiness window; the id is what matters.
    target = await this.snapshotMedia(store, params.productId, params.targetMediaId)
    if (target) {
      await this.moveMedia(store, params.productId, newMediaId, target.position)
      await this.deleteMedia(store, params.productId, target.id)
    }
    return { mediaId: newMediaId }
  }

  /** Add media to the product (the add-new / add-featured publish path). Resumable. */
  async addMedia(store: StoreRecord, params: AddMediaParams): Promise<{ mediaId: string }> {
    const mediaId =
      (await this.resumeCreatedMedia(store, params.productId, params.createdMediaId, params.mediaType)) ??
      (await this.createMediaAndAwaitReady(
        store,
        params.productId,
        params.url,
        params.altText,
        params.mediaType,
        params.onCreated,
      ))
    // New media lands at the end; move it to the requested slot (e.g. featured),
    // keeping the prior occupant — which simply shifts down.
    if (params.position !== undefined) {
      await this.moveMedia(store, params.productId, mediaId, params.position)
    }
    return { mediaId }
  }

  /** Delete one media — revert of an add-new publish. Idempotent: gone ⇒ no-op. */
  async removeMedia(store: StoreRecord, productId: string, mediaId: string): Promise<void> {
    const existing = await this.snapshotMedia(store, productId, mediaId)
    if (!existing) return
    await this.deleteMedia(store, productId, mediaId)
  }

  /**
   * Revert of a replace publish — never touches a position occupant. The
   * published media is resolved BY ID; the restored media takes its current
   * slot (preserving the operator's arrangement) and only it is deleted. When
   * the published media is already gone the goal state is achieved: place the
   * restored media at the snapshot's slot and delete nothing.
   */
  async restoreMedia(store: StoreRecord, params: RestoreMediaParams): Promise<{ mediaId: string }> {
    const published = await this.snapshotMedia(store, params.productId, params.publishedMediaId)
    const restoredId = await this.createMediaAndAwaitReady(
      store,
      params.productId,
      params.snapshot.url,
      params.snapshot.altText,
      params.snapshot.mediaType ?? 'image',
    )
    if (published) {
      await this.moveMedia(store, params.productId, restoredId, published.position)
      await this.deleteMedia(store, params.productId, published.id)
    } else {
      await this.moveMedia(store, params.productId, restoredId, params.snapshot.position)
    }
    return { mediaId: restoredId }
  }

  async disconnect(_store: StoreRecord): Promise<void> {
    // Token row is deleted by the store service; nothing Shopify-side to do.
    // (App uninstall is performed by the merchant in Shopify admin.)
  }
}
