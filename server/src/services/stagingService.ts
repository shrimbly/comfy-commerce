import { randomUUID } from 'node:crypto'

import {
  countByState,
  type GalleryArrangement,
  type GallerySlotRef,
  type StageAction,
  type StagedMediaType,
  type StagingItem,
  type StagingState,
} from '@comfy-commerce/shared'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { ConnectorRegistry } from '../connectors/index.js'
import type { Db } from '../db/client.js'
import { galleryArrangements, stagingItems } from '../db/schema.js'
import type { Env } from '../env.js'
import { fetchWithTimeout } from '../http.js'
import type { AssetStore } from './assetStore.js'
import type { Audit } from './audit.js'
import type { StoreService } from './storeService.js'

export interface StageInput {
  storeId: string
  productId: string
  /** Media being replaced (for add-new: the source media the result came from). */
  mediaId: string
  afterUrl: string
  /** Workflows can emit videos as well as images. */
  mediaType?: StagedMediaType
  action: StageAction
  variantTitle?: string | null
  recipeId?: string | null
  runId?: string | null
  source: 'ui' | 'api'
}

export interface OperationResult {
  id: string
  ok: boolean
  state: StagingState
  error: string | null
}

type Row = typeof stagingItems.$inferSelect

/**
 * Take custody of remote prior-media bytes before the destructive publish.
 * Shopify deletes the old media; its CDN URL is not guaranteed to survive,
 * so revert must never depend on it. Local/mock URLs are already ours.
 * Best-effort: any fetch failure falls back to the original CDN URL.
 */
export async function takeCustodyOfUrl(assetStore: AssetStore, url: string): Promise<string> {
  if (!/^https?:\/\//.test(url)) return url
  try {
    // Timeout (no retries) so a stalling CDN can't hang the publish; a
    // timeout falls back to the CDN URL like any other custody failure.
    const res = await fetchWithTimeout(url, { timeoutMs: 60_000 })
    if (!res.ok) return url
    const bytes = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    const saved = await assetStore.save(bytes, contentType)
    return saved.url
  } catch {
    return url // best effort — fall back to the CDN URL
  }
}

function toItem(row: Row): StagingItem {
  return {
    id: row.id,
    storeId: row.storeId,
    productId: row.productId,
    productTitle: row.productTitle,
    variantTitle: row.variantTitle,
    beforeUrl: row.beforeUrl,
    afterUrl: row.afterUrl,
    mediaType: row.mediaType,
    action: row.action,
    targetPosition: row.targetPosition,
    targetMediaId: row.targetMediaId ?? null,
    sourceMediaId: row.sourceMediaId ?? null,
    priorMediaSnapshot: row.priorMediaSnapshot ?? null,
    publishedMediaId: row.publishedMediaId ?? null,
    state: row.state,
    error: row.error ?? null,
    recipeId: row.recipeId,
    runId: row.runId,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The staging ledger — a first-class, server-side object.
 *
 * THE GATE lives here: `publish` refuses any item that is not `approved`,
 * and `stage` always creates `pending` items, no matter who calls it (UI or
 * headless API). Before every destructive write the prior media is
 * snapshotted onto the item so revert is always possible.
 */
export function createStagingService(
  db: Db,
  env: Env,
  connectors: ConnectorRegistry,
  storeService: StoreService,
  audit: Audit,
  assetStore: AssetStore,
) {
  function rows(ids: string[]): Row[] {
    if (ids.length === 0) return []
    return db.select().from(stagingItems).where(inArray(stagingItems.id, ids)).all()
  }

  function setState(id: string, state: StagingState, error: string | null = null): void {
    db.update(stagingItems)
      .set({ state, error, updatedAt: new Date().toISOString() })
      .where(eq(stagingItems.id, id))
      .run()
  }

  /** Patch specific columns without touching `state`/`updatedAt` (snapshots, published ids). */
  function patchRow(id: string, patch: Partial<typeof stagingItems.$inferInsert>): void {
    db.update(stagingItems).set(patch).where(eq(stagingItems.id, id)).run()
  }

  /** Root-relative URLs (mock CDN, local assets) become absolute for connectors. */
  function absolutize(url: string): string {
    return url.startsWith('/') ? `${env.appUrl}${url}` : url
  }

  /** Approved/failed/published rows for one product (gallery editor + reorder). */
  function productRows(storeId: string, productId: string, states: StagingState[]): Row[] {
    return db
      .select()
      .from(stagingItems)
      .where(
        and(
          eq(stagingItems.storeId, storeId),
          eq(stagingItems.productId, productId),
          inArray(stagingItems.state, states),
        ),
      )
      .all()
  }

  function loadArrangement(storeId: string, productId: string): GallerySlotRef[] | null {
    const row = db
      .select()
      .from(galleryArrangements)
      .where(
        and(eq(galleryArrangements.storeId, storeId), eq(galleryArrangements.productId, productId)),
      )
      .get()
    return row?.order ?? null
  }

  function writeArrangement(storeId: string, productId: string, order: GallerySlotRef[]): void {
    const updatedAt = new Date().toISOString()
    db.insert(galleryArrangements)
      .values({ storeId, productId, order, updatedAt })
      .onConflictDoUpdate({
        target: [galleryArrangements.storeId, galleryArrangements.productId],
        set: { order, updatedAt },
      })
      .run()
  }

  /** Drop a staged item's slot from its product arrangement (on reject). */
  function pruneSlot(storeId: string, productId: string, itemId: string): void {
    const order = loadArrangement(storeId, productId)
    if (!order) return
    const next = order.filter((s) => !(s.kind === 'staged' && s.itemId === itemId))
    if (next.length !== order.length) writeArrangement(storeId, productId, next)
  }

  /**
   * Recover items orphaned in 'publishing' by a broker crash (mirrors
   * runService.recoverOrphanedRuns; runs once at construction — buildApp
   * creates this service before any route registration, so no race). Uses
   * ONLY the existing publishing→failed 'fail' edge and NEVER auto-publishes:
   * even when publishedMediaId shows the media was created on the live store,
   * the operator must re-review and retry via the atomic failed→publishing
   * claim (idempotent — resumes via createdMediaId) or reject.
   */
  function recoverInterruptedPublishes(): void {
    const orphans = db.select().from(stagingItems).where(eq(stagingItems.state, 'publishing')).all()
    for (const row of orphans) {
      // Per publishOne's ordering contract, a non-null publishedMediaId means
      // the media WAS created on the live store (possibly still transcoding).
      const mayBeLive = Boolean(row.publishedMediaId)
      setState(
        row.id,
        'failed',
        mayBeLive
          ? 'Interrupted — broker restarted mid-publish; the media may already be live on the store. Verify the product gallery before retrying.'
          : 'Interrupted — broker restarted mid-publish',
      )
      audit.record({
        storeId: row.storeId,
        itemId: row.id,
        action: 'staging.publish-interrupted',
        detail: { publishedMediaId: row.publishedMediaId ?? null },
      })
    }
  }
  recoverInterruptedPublishes()

  /**
   * CRASH-SAFETY ORDERING CONTRACT (the boot recovery sweep relies on this):
   *  (a) `publishing` is entered ONLY via the atomic claim below;
   *  (b) priorMediaSnapshot is persisted BEFORE any live-store mutation;
   *  (c) publishedMediaId is persisted the moment the connector acknowledges
   *      media creation (onCreated) — BEFORE the readiness wait / move / delete;
   *  (d) state `published` is set only after the connector returns.
   * A row found in `publishing` at boot may therefore be safely flipped to
   * `failed`, and re-publishing it is idempotent: the retry resumes via
   * createdMediaId (never double-creates) and deletes only by media id
   * (never harms repositioned media).
   */
  /**
   * Ids with a revert in flight in THIS process. Revert has no persisted
   * transient state (unlike publish's atomic approved/failed→publishing claim),
   * so a double-clicked or concurrent Revert would otherwise both pass the
   * published-state check and each create-and-restore, leaving a duplicate of
   * the original live on the store (restoreMedia is create-based, not
   * idempotent). This reentrancy guard serialises reverts of the same item;
   * the broker is single-process, so an in-memory set is sufficient. (A crash
   * mid-revert is a separate, non-destructive concern — the retry can duplicate
   * the restored original, which the operator removes manually.)
   */
  const revertingIds = new Set<string>()

  async function publishOne(row: Row): Promise<OperationResult> {
    const store = storeService.getRow(row.storeId)
    if (!store) return { id: row.id, ok: false, state: row.state, error: 'Store not found' }
    const connector = connectors.forStore(store)

    // THE GATE — claimed ATOMICALLY against the live row, not the passed-in
    // snapshot. Only one caller can transition approved/failed → publishing; a
    // concurrent or duplicate publish (e.g. a double-clicked "Publish all")
    // claims 0 rows and bails. This is what stops the non-atomic replace from
    // running twice and leaving a duplicate (new media added, old not removed).
    const claimed = db
      .update(stagingItems)
      .set({ state: 'publishing', error: null, updatedAt: new Date().toISOString() })
      .where(and(eq(stagingItems.id, row.id), inArray(stagingItems.state, ['approved', 'failed'])))
      .run()
    if (claimed.changes === 0) {
      const live = db.select().from(stagingItems).where(eq(stagingItems.id, row.id)).get()
      const state = live?.state ?? row.state
      return {
        id: row.id,
        ok: state === 'published',
        state,
        error: state === 'published' ? null : `Cannot publish from '${state}' — approval is mandatory`,
      }
    }

    // Re-read the live row after winning the claim: a prior failed attempt may
    // have recorded priorMediaSnapshot / publishedMediaId / targetMediaId that
    // the caller's snapshot (read before the claim) does not carry — resume
    // correctness depends on the freshest values, and reusing a stale snapshot
    // here could overwrite the one the first attempt persisted.
    const live = db.select().from(stagingItems).where(eq(stagingItems.id, row.id)).get() ?? row

    try {
      if (row.action === 'add-new' || row.action === 'add-featured') {
        // Non-destructive: add the result as product media — appended, or
        // inserted at the featured slot, keeping whatever was there before.
        const { mediaId } = await connector.addMedia(store, {
          productId: row.productId,
          url: absolutize(row.afterUrl),
          altText: row.productTitle,
          mediaType: row.mediaType,
          ...(row.action === 'add-featured' ? { position: 1 } : {}),
          createdMediaId: live.publishedMediaId,
          onCreated: (id) => patchRow(row.id, { publishedMediaId: id }),
        })
        patchRow(row.id, { publishedMediaId: mediaId })
        setState(row.id, 'published')
        audit.record({ storeId: row.storeId, itemId: row.id, action: 'staging.publish' })
        return { id: row.id, ok: true, state: 'published', error: null }
      }

      // Resolve WHICH media this item replaces — strictly by id. Legacy rows
      // (staged before identity tracking) fall back to position + beforeUrl
      // agreement and adopt the id; no match ⇒ fail. Never blind position
      // addressing: a shifted gallery must fail the item, not hit a bystander.
      let targetMediaId = live.targetMediaId
      if (!targetMediaId) {
        const product = await connector.getProduct(store, row.productId)
        const candidate = product?.media.find(
          (m) => m.position === row.targetPosition && m.url === row.beforeUrl,
        )
        if (!candidate) {
          throw new Error('Cannot identify the media to replace — re-stage this item')
        }
        targetMediaId = candidate.id
        patchRow(row.id, { targetMediaId })
      }

      // Snapshot prior media immediately before the destructive mutation. A
      // resume reuses the persisted snapshot verbatim — the guarded UPDATE
      // (WHERE prior_media_snapshot IS NULL) can never overwrite it.
      let snapshot = live.priorMediaSnapshot
      if (!snapshot) {
        snapshot = await connector.snapshotMedia(store, row.productId, targetMediaId)
        if (!snapshot && !live.publishedMediaId) {
          throw new Error(
            'Target media no longer exists on the store — re-stage this item against the current catalog',
          )
        }
        if (snapshot) {
          snapshot = { ...snapshot, url: await takeCustodyOfUrl(assetStore, snapshot.url) }
          db.update(stagingItems)
            .set({ priorMediaSnapshot: snapshot })
            .where(and(eq(stagingItems.id, row.id), isNull(stagingItems.priorMediaSnapshot)))
            .run()
        }
      }
      const { mediaId } = await connector.replaceMedia(store, {
        productId: row.productId,
        targetMediaId,
        newUrl: absolutize(row.afterUrl),
        altText: snapshot?.altText ?? row.productTitle,
        mediaType: row.mediaType,
        createdMediaId: live.publishedMediaId,
        onCreated: (id) => patchRow(row.id, { publishedMediaId: id }),
      })
      // Record the new media id so a saved gallery arrangement can reposition
      // the replacement (publishGallery resolves staged slots → live media ids).
      patchRow(row.id, { publishedMediaId: mediaId })
      setState(row.id, 'published')
      audit.record({ storeId: row.storeId, itemId: row.id, action: 'staging.publish' })
      return { id: row.id, ok: true, state: 'published', error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setState(row.id, 'failed', message)
      audit.record({
        storeId: row.storeId,
        itemId: row.id,
        action: 'staging.publish-failed',
        detail: { error: message },
      })
      return { id: row.id, ok: false, state: 'failed', error: message }
    }
  }

  return {
    async list(storeId?: string) {
      const base = db.select().from(stagingItems)
      const query = storeId ? base.where(eq(stagingItems.storeId, storeId)) : base
      const items = query.orderBy(desc(stagingItems.createdAt)).all().map(toItem)
      return { items, counts: countByState(items) }
    },

    /** Stage edits for review. ALWAYS creates `pending` — no bypass exists. */
    async stage(inputs: StageInput[]): Promise<StagingItem[]> {
      const created: StagingItem[] = []
      for (const input of inputs) {
        const store = storeService.requireRow(input.storeId)
        const connector = connectors.forStore(store)
        const product = await connector.getProduct(store, input.productId)
        if (!product) throw Object.assign(new Error(`Product not found: ${input.productId}`), { statusCode: 404 })
        const media = product.media.find((m) => m.id === input.mediaId)
        if (!media) throw Object.assign(new Error(`Media not found: ${input.mediaId}`), { statusCode: 404 })

        const targetPosition =
          input.action === 'add-featured'
            ? 1
            : input.action === 'add-new'
              ? product.media.length + 1
              : media.position
        // For add-featured the "before" is the current featured image — what
        // the new result will sit in front of (and revert restores).
        const before =
          input.action === 'add-featured'
            ? (product.media.find((m) => m.position === 1) ?? media)
            : media

        const now = new Date().toISOString()
        const row: typeof stagingItems.$inferInsert = {
          id: randomUUID(),
          storeId: input.storeId,
          productId: input.productId,
          productTitle: product.title,
          variantTitle: input.variantTitle ?? null,
          beforeUrl: before.url,
          afterUrl: input.afterUrl,
          mediaType: input.mediaType ?? 'image',
          action: input.action,
          targetPosition,
          // Identity captured at stage time: for replace-position the media a
          // publish will delete; for add-* the source media (informational).
          targetMediaId: input.mediaId,
          // Immutable provenance — which media the workflow ran on (targetMediaId
          // is operational and gets re-pointed on revert; this never changes).
          sourceMediaId: input.mediaId,
          priorMediaSnapshot: null,
          publishedMediaId: null,
          state: 'pending',
          recipeId: input.recipeId ?? null,
          runId: input.runId ?? null,
          source: input.source,
          error: null,
          createdAt: now,
          updatedAt: now,
        }
        db.insert(stagingItems).values(row).run()
        audit.record({
          storeId: input.storeId,
          itemId: row.id,
          action: 'staging.stage',
          detail: { source: input.source, product: product.title },
        })
        created.push(toItem(row as Row))
      }
      return created
    },

    approve(ids: string[]): OperationResult[] {
      return rows(ids).map((row) => {
        if (row.state !== 'pending') {
          return { id: row.id, ok: false, state: row.state, error: `Cannot approve from '${row.state}'` }
        }
        setState(row.id, 'approved')
        audit.record({ storeId: row.storeId, itemId: row.id, action: 'staging.approve' })
        return { id: row.id, ok: true, state: 'approved' as const, error: null }
      })
    },

    reject(ids: string[]): OperationResult[] {
      return rows(ids).map((row) => {
        if (row.state !== 'pending' && row.state !== 'approved' && row.state !== 'failed') {
          return { id: row.id, ok: false, state: row.state, error: `Cannot reject from '${row.state}'` }
        }
        setState(row.id, 'rejected')
        pruneSlot(row.storeId, row.productId, row.id)
        audit.record({ storeId: row.storeId, itemId: row.id, action: 'staging.reject' })
        return { id: row.id, ok: true, state: 'rejected' as const, error: null }
      })
    },

    async publish(ids: string[]): Promise<OperationResult[]> {
      const results: OperationResult[] = []
      for (const row of rows(ids)) {
        results.push(await publishOne(row))
      }
      return results
    },

    /** Gallery editor model for the Approved tab: existing media + approved results + saved order. */
    async galleryEditor(storeId: string, productId: string) {
      const store = storeService.requireRow(storeId)
      const product = await connectors.forStore(store).getProduct(store, productId)
      const approvedItems = productRows(storeId, productId, ['approved', 'failed']).map(toItem)
      return {
        productId,
        productTitle: product?.title ?? approvedItems[0]?.productTitle ?? productId,
        media: product?.media ?? [],
        approvedItems,
        arrangement: loadArrangement(storeId, productId),
      }
    },

    /** Persist a product's full-gallery order (staged refs validated against arrangeable items). */
    saveArrangement(input: {
      storeId: string
      productId: string
      order: GallerySlotRef[]
    }): GalleryArrangement {
      const valid = new Set(
        productRows(input.storeId, input.productId, ['approved', 'failed', 'published']).map(
          (r) => r.id,
        ),
      )
      const order = input.order.filter((s) => s.kind === 'media' || valid.has(s.itemId))
      writeArrangement(input.storeId, input.productId, order)
      audit.record({
        storeId: input.storeId,
        action: 'staging.arrange',
        detail: { productId: input.productId, slots: order.length },
      })
      return { storeId: input.storeId, productId: input.productId, order, updatedAt: new Date().toISOString() }
    },

    /**
     * Publish a product's approved set, then enforce the saved gallery order in
     * one reorder. No arrangement ⇒ behaves like per-item publish.
     */
    async publishGallery(
      storeId: string,
      productId: string,
    ): Promise<{ results: OperationResult[]; reordered: boolean; error: string | null }> {
      const store = storeService.requireRow(storeId)
      const connector = connectors.forStore(store)
      const results: OperationResult[] = []
      for (const row of productRows(storeId, productId, ['approved', 'failed'])) {
        results.push(await publishOne(row))
      }

      const arrangement = loadArrangement(storeId, productId)
      if (!arrangement) return { results, reordered: false, error: null }

      const product = await connector.getProduct(store, productId)
      const liveIds = new Set((product?.media ?? []).map((m) => m.id))
      const publishedMedia = new Map(
        productRows(storeId, productId, ['published']).map((r) => [r.id, r.publishedMediaId]),
      )
      const resolvedIds: string[] = []
      const resolvedRefs: GallerySlotRef[] = []
      for (const slot of arrangement) {
        const mediaId = slot.kind === 'media' ? slot.mediaId : publishedMedia.get(slot.itemId)
        if (mediaId && liveIds.has(mediaId)) {
          resolvedIds.push(mediaId)
          resolvedRefs.push({ kind: 'media', mediaId })
        }
      }
      if (resolvedIds.length === 0) return { results, reordered: false, error: null }
      try {
        await connector.reorderMedia(store, productId, resolvedIds)
        writeArrangement(storeId, productId, resolvedRefs)
        audit.record({ storeId, action: 'staging.reorder', detail: { productId, slots: resolvedIds.length } })
        return { results, reordered: true, error: null }
      } catch (err) {
        return { results, reordered: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    /** Revert a publish: restore the prior-media snapshot on the live store. */
    async revert(ids: string[]): Promise<OperationResult[]> {
      const results: OperationResult[] = []
      for (const row of rows([...new Set(ids)])) {
        if (row.state !== 'published') {
          results.push({ id: row.id, ok: false, state: row.state, error: `Cannot revert from '${row.state}'` })
          continue
        }
        // add-featured/add-new are non-destructive adds — revert removes the
        // media the publish created; replace-position restores its snapshot.
        const isAdd = row.action === 'add-new' || row.action === 'add-featured'
        if (!isAdd && !row.priorMediaSnapshot) {
          results.push({ id: row.id, ok: false, state: row.state, error: 'No prior-media snapshot' })
          continue
        }
        // Replace-revert is id-addressed: without the published media's id we
        // would have to guess by position — refuse instead (legacy rows only).
        if (!isAdd && !row.publishedMediaId) {
          results.push({
            id: row.id,
            ok: false,
            state: row.state,
            error: 'No published media id recorded — remove the media in the store admin',
          })
          continue
        }
        if (isAdd && !row.publishedMediaId) {
          results.push({ id: row.id, ok: false, state: row.state, error: 'No published media to remove' })
          continue
        }
        const store = storeService.getRow(row.storeId)
        if (!store) {
          results.push({ id: row.id, ok: false, state: row.state, error: 'Store not found' })
          continue
        }
        // Serialise reverts of the same item — a concurrent/double-clicked
        // Revert would otherwise duplicate the restored media on the store.
        if (revertingIds.has(row.id)) {
          results.push({ id: row.id, ok: false, state: row.state, error: 'A revert is already in progress for this item' })
          continue
        }
        revertingIds.add(row.id)
        try {
          if (isAdd) {
            // Revert of an addition: delete the media the publish created.
            await connectors.forStore(store).removeMedia(store, row.productId, row.publishedMediaId!)
            patchRow(row.id, { publishedMediaId: null })
          } else {
            const { mediaId: restoredId } = await connectors.forStore(store).restoreMedia(store, {
              productId: row.productId,
              snapshot: {
                ...row.priorMediaSnapshot!,
                url: absolutize(row.priorMediaSnapshot!.url),
              },
              publishedMediaId: row.publishedMediaId!,
            })
            // Re-point the item at the restored copy: the original media id is
            // gone from the store, so a re-publish (published → approved is a
            // documented re-publishable state) must target the restored media.
            patchRow(row.id, {
              publishedMediaId: null,
              targetMediaId: restoredId,
              priorMediaSnapshot: { ...row.priorMediaSnapshot!, id: restoredId },
            })
          }
          setState(row.id, 'approved')
          audit.record({ storeId: row.storeId, itemId: row.id, action: 'staging.revert' })
          results.push({ id: row.id, ok: true, state: 'approved', error: null })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          results.push({ id: row.id, ok: false, state: row.state, error: message })
        } finally {
          revertingIds.delete(row.id)
        }
      }
      return results
    },
  }
}

export type StagingService = ReturnType<typeof createStagingService>
