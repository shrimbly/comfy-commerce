# Shopify Link — Project Brief & Handoff

> **Audience:** an engineer/model bootstrapping this as a **standalone project in a sibling
> directory, outside the ComfyUI codebase.** This is **not** a native ComfyUI feature. It is its
> own product that links a merchant's Shopify store, pulls product media, runs AI edits on that
> media (delegating the actual generation to a pluggable engine — e.g. Comfy Cloud, a local
> ComfyUI, or a partner image API), stages the results for human review, and publishes approved
> edits back to the store.
>
> A working **click-through prototype already exists** inside the ComfyUI frontend repo (paths
> below). It is throwaway/reference only — port the ideas and code, don't depend on it.

---

## 1. TL;DR

Build "Shopify Link": a pluggable connector + review pipeline that lets a merchant (or an agency
managing many merchants) **link a Shopify store, browse its product media, AI-edit images,
review every edit, and publish approved results back to live listings.** Shopify is connector #1
behind a generic *media-source* interface (WooCommerce, Drive, S3, etc. follow later).

The defining constraints (all locked with the product owner — see §3):

- **Full round-trip** (import *and* push edits back), not read-only.
- **One-click OAuth** connection ("very easy and pluggable").
- **Live-linked** media source (browsable, materialized on use), not a one-time copy.
- Works whether the AI editing runs **locally or over an API**, and the whole loop is
  **automatable headless** (operations exposed programmatically), not only via clicking.
- **Brokered token custody** (the access token lives on the project's server), with an opt-in
  local-token mode for advanced/offline users.
- **Replace-in-place** push semantics, made safe by a **snapshot-for-revert** of the prior media.
- A **mandatory staging/review gate**: *nothing* reaches a live store without human approval —
  **automated/headless pipelines stage into the same queue.**

---

## 2. What this is, and what it is NOT

**IS:**
- A standalone web app + backend ("broker"). The backend owns OAuth, token custody, the Shopify
  API calls, and the staging ledger. The frontend is the merchant/agency UI.
- An AI image-editing review tool oriented around e-commerce product photography (relight,
  background swap/removal, variant generation, upscale, cleanup, etc.).
- A connector platform: Shopify first, designed so other commerce/media sources plug in.

**IS NOT:**
- A ComfyUI extension, custom node pack, or frontend feature. It does not live in or ship with
  ComfyUI.
- A generation engine. It **delegates** the actual pixel work to a pluggable "generation
  provider." Comfy (Cloud API or a local ComfyUI instance) is the expected first provider, but
  the boundary must stay clean so other providers (partner image APIs, etc.) can be swapped in.

**Relationship to Comfy:** Comfy is (a) the most likely AI editing engine behind the "Edit" step,
and (b) the origin of the reference prototype's design language. Treat Comfy as a *provider*, not
a host.

---

## 3. Locked product decisions (with rationale)

These came out of a structured discovery Q&A with the product owner. Treat them as fixed unless
re-opened.

| # | Decision | Chosen | Why / notes |
|---|----------|--------|-------------|
| 1 | Scope of v1 loop | **Full round-trip** (import + push back) | The magic is closing the loop — edit a product photo and update the listing. Needs `write_products`, plus mapping/QA/undo. |
| 2 | Connection method | **One-click OAuth app** | The "very easy & pluggable" promise: enter shop domain → approve on Shopify → done. Requires a published Shopify app + a backend OAuth callback. |
| 3 | Media representation | **Live-linked source** | Store stays connected as a browsable source; images materialize into working assets only on use and reflect catalog changes. Matches the "link" framing; avoids bulk-copying large catalogs. |
| 4 | "Works locally or over the API" | **Both** | (a) The editing engine can be a local ComfyUI **or** a hosted API; AND (b) the import→edit→stage→publish operations are exposed as programmatic/automatable steps so the loop runs headless, not only via the GUI. |
| 5 | Token custody (local runtime) | **Brokered, local opt-in** | Token stays on the project's broker by default (reads hit the public CDN; writes proxy through the broker). Advanced users may opt into a locally-stored scoped token for autonomy/offline. |
| 6 | Push-back semantics | **Replace-in-place** | Overwrite the targeted media/position on the live listing. Destructive — so it is gated by review AND protected by a prior-media snapshot enabling one-click revert. |
| 7 | Review gate for headless pipelines | **Always stage for review** | Even fully automated runs enqueue into the review queue; a human approves before anything hits a live store. The gate is universal. |

**Implication of #6 + #7:** the review queue is a first-class, server-side object. Publishing is
a deliberate human action; the broker snapshots prior media right before any destructive write so
revert is always possible.

---

## 4. System architecture

The central idea: **separate the control plane from the data plane.** This is what makes
"local or API" and "stage before push" both work without forking the codebase.

```
                          ┌─────────────────────────────────────────┐
                          │            CONTROL PLANE                  │
                          │   "Shopify Link broker" (this project's   │
                          │    backend — always server-side)          │
                          │                                           │
  Shopify  ◀── OAuth ────▶│  • OAuth handshake + HMAC verify          │
  (Partner app)           │  • Access-token custody (per shop)        │
                          │  • Catalog/metadata queries (Admin API)   │
                          │  • Staging ledger (state machine)         │
                          │  • Write proxy (push-back mutations)      │
                          │  • Webhooks (catalog changes)             │
                          └───────────────┬───────────────────────────┘
                                          │ control (auth, metadata, staging state)
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                  │
        ▼                                 ▼                                  ▼
  ┌───────────┐                   ┌───────────────┐                  ┌────────────────┐
  │  Frontend │                   │  DATA PLANE   │                  │  GENERATION    │
  │  (web UI) │                   │  (pixels)     │                  │  PROVIDER      │
  └───────────┘                   │               │                  │  (pluggable)   │
                                  │ reads: fetch  │                  │  • Comfy Cloud │
                                  │ image bytes   │                  │    API         │
                                  │ DIRECTLY from │                  │  • local       │
                                  │ Shopify's     │                  │    ComfyUI     │
                                  │ public CDN    │                  │  • partner img │
                                  │ (no token)    │                  │    API         │
                                  │ writes: via   │                  └────────────────┘
                                  │ broker proxy  │
                                  └───────────────┘
```

### Key insight: Shopify product image URLs are public
Product media are served from `cdn.shopify.com` and are publicly fetchable. So **reads/imports
barely need the token** — the broker enumerates products (Admin API) and returns image URLs;
the frontend or the generation provider fetches the pixels straight from the CDN. **Only catalog
listing and write-back require the secret token**, and writes always route through the broker
(or the opt-in local token).

### Control plane (always the broker)
OAuth one-click only works if a server you control holds the app's `client_secret`, owns the
registered redirect URI, and performs the code→token exchange + HMAC verification. A user's local
machine cannot do that securely. So **the handshake and token custody are centralized in the
broker, regardless of where editing runs.** The broker also owns the staging ledger so review
state is consistent and survives client restarts.

### Data plane (adapts to runtime)
- **Hosted/API editing:** everything server-side; token never touches a browser.
- **Local editing (ComfyUI on the user's box):** reads = direct CDN fetch (no secret on the box);
  writes = local client hands the approved image to the broker, which performs the Shopify
  mutation. Token stays server-side by default. **Opt-in local-token mode** lets the local client
  hold a scoped offline token and call Shopify directly (more autonomous, higher exposure).

### Generation provider (pluggable)
Define a narrow interface, e.g. `edit(image, recipe) -> editedImage(s)`. Implement it for Comfy
Cloud API and local ComfyUI first. The review pipeline does not care which provider produced the
"after" image.

---

## 5. Domain model

Ported from the prototype (`src/platform/shopify/types.ts`). Shopify-shaped but clean. Adjust
field names to your backend conventions.

```ts
type StoreStatus = 'connected' | 'connecting' | 'error'
type ProductStatus = 'active' | 'draft' | 'archived'
// Which media of each product are exposed to the tool.
type MediaRole = 'featured' | 'all' | 'all-with-video'

interface ShopifyMedia {
  id: string
  url: string          // public CDN url
  altText: string
  position: number     // 1-based position within the product's media list
}

interface ShopifyVariant {
  id: string
  title: string        // e.g. "White / M"
}

interface ShopifyProduct {
  id: string
  title: string
  status: ProductStatus
  collectionIds: string[]
  tags: string[]
  media: ShopifyMedia[]
  variants: ShopifyVariant[]
}

interface ShopifyCollection {
  id: string
  title: string
}

// A saved "what should the tool see" filter, per connected store.
interface ScopeProfile {
  collectionIds: string[] | 'all'
  tags: string[]
  productStatus: ProductStatus
  mediaRole: MediaRole
}

interface ConnectedStore {
  id: string
  domain: string            // mystore.myshopify.com
  status: StoreStatus
  scopes: string[]          // e.g. ['read_products', 'write_products']
  syncedLabel: string       // human label; real impl: lastSyncedAt timestamp
  scopeProfile: ScopeProfile
}

// ── Staging / review ──────────────────────────────────────────────
type StagingState =
  | 'pending'      // freshly staged, awaiting human decision
  | 'approved'     // human approved; ready to publish, not yet live
  | 'publishing'   // mutation in flight
  | 'published'    // live on the storefront
  | 'rejected'     // human rejected; will not publish
  | 'failed'       // publish attempt errored; retryable

type StageAction = 'replace-featured' | 'replace-position'

interface StagingItem {
  id: string
  storeId: string
  productId: string
  productTitle: string
  variantTitle: string | null     // null => applies to product / "All variants"
  beforeUrl: string               // the live media being replaced
  afterUrl: string                // the AI-edited result
  action: StageAction
  targetPosition: number          // which media slot is being replaced
  priorMediaSnapshot: ShopifyMedia | null  // SAFETY NET for revert (see §6)
  state: StagingState
}
```

**Multi-store / agency note:** model stores as a list from day one. Agencies managing many client
stores are an explicit target — they especially value the review gate (client sign-off before
touching a client's live store) and multi-store linking.

---

## 6. The staging state machine (the heart of the review gate)

Ported from `src/platform/shopify/stagingMachine.ts`. Implement these as **pure, total
transitions** (easy to unit-test; the prototype has 6 passing tests on exactly this).

```
                stage()                 approve()               publish()
   (none) ───────────────▶ pending ───────────────▶ approved ───────────────▶ published
                              │  │                      │                          │
                       reject │  └──────────────────────┤ reject                   │ revert
                              ▼                          ▼                          ▼
                          rejected                   rejected                  approved
                                                                          (prior media restored
                                                                           on the live store)

   publishing/failed: transient states around the actual mutation; failed is retryable.
```

**The gate rules (must hold):**
- `stage()` creates items in **`pending`**. (Headless/automated pipelines also create `pending` —
  no bypass.)
- `approve()`: `pending → approved`.
- `publish()`: **`approved → published` ONLY.** A `pending` item can never be published directly —
  approval is mandatory. This is the gate, enforced in code, not just UI.
- `reject()`: `pending | approved → rejected`.
- `revert()`: `published → approved` — undo the publish and **restore `priorMediaSnapshot`** on the
  live store. (Re-publishable afterward.)
- "Approve & publish" in the UI is `approve()` then `publish()` as one human action — still no
  silent bypass.

**Replace-in-place safety:** because publishing overwrites live media, the broker must **snapshot
the prior media (URL/source, position, altText) immediately before the destructive mutation** and
store it on the `StagingItem`. Revert re-creates media from that snapshot and re-orders it back.

Reference (pure functions, immutable):
```ts
function transition(items, ids, allowedFrom: StagingState[], to: StagingState): StagingItem[]
approveItems  = transition(.., ['pending'],              'approved')
rejectItems   = transition(.., ['pending','approved'],   'rejected')
publishItems  = transition(.., ['approved'],             'published')   // GATE
revertItems   = transition(.., ['published'],            'approved')
countByState(items) -> Record<StagingState, number>
```

---

## 7. End-to-end workflow

1. **Connect** — Settings/Connectors → Shopify → *Connect*. Enter shop domain
   (`mystore.myshopify.com`).
2. **Authorize** — Redirect to Shopify consent screen for `read_products` (+ `write_products` for
   push-back). Approve → broker exchanges code for an offline token → stored. Connection row shows
   store name, granted scopes, last sync.
3. **Scope** — Choose what media to expose as a saved **sync profile**: filter by collection / tag
   / product status, and pick media role (featured only / all images / include video+3D). Show a
   live count ("≈ 1,240 images across 312 products"). Sensible default: featured image of active
   products.
4. **Browse & select** — Shopify appears as a *source*. Navigate Collections → Products → media
   grid; multi-select; "select all in scope."
5. **Edit** — Selected images flow into a generation recipe (relight, bg swap, upscale, variant
   gen, …) run by the **generation provider** (local ComfyUI or cloud API). Produces "after"
   images.
6. **Stage** — Each result is staged with a target (product/variant) + action (replace featured /
   replace position N) → lands in the review queue as **pending**. (Headless pipelines call the
   same stage operation.)
7. **Review** — Queue shows before (live) vs after (edited), the destination listing, the action,
   and Approve / Reject (bulk + per-item). Edit target/action if needed.
8. **Publish** — Approved items are pushed via the broker (snapshot prior media first → mutate →
   mark `published`). Failures surface with retry. **Revert** restores prior media.

---

## 8. UI surfaces & wireframes

The prototype implements all of these (see §10 for the file map and §11 for canonical copy).

### 8.1 Connectors / Connected services
Multi-store list under a "Shopify" connector; each store shows status dot, granted scopes, last
sync, Disconnect; a *Connect* button; "Coming soon" rows for future connectors (WooCommerce,
Google Drive). Below it, the **scope editor** for the active store (status + media-role controls +
live in-scope count).

```
Connected services
┌────────────────────────────────────────────────────────────┐
│ ◇ Shopify                                      [ + Connect ] │
│    ● mystore.myshopify.com   read+write · synced just now    │
│                                                  Disconnect   │
│ ◇ WooCommerce                                   Coming soon  │
│ ◇ Google Drive                                  Coming soon  │
└────────────────────────────────────────────────────────────┘
What media should Comfy see?
  Status [Active] Draft Archived    Media role [Featured only] All images  All+video/3D
  ≈ 5 images across 5 products
```

### 8.2 Connect dialog
```
Connect Shopify
Store domain  [ mystore ] .myshopify.com
We'll request:  • Read products & media   • Write products & media
                                  [ Cancel ]   [ Continue to Shopify → ]
```

### 8.3 Media browser (source = "Shopify · <domain>")
Header with source name + Select all / Clear; products listed with their in-scope media as
selectable thumbnails (ring + check when selected); a selection action bar with the stage action
toggle (Replace featured / Replace in place), a "Use in workflow" affordance, and "Edit & stage".

### 8.4 Review queue + review card (the star surface)
Summary line ("N pending · N approved · N published") + a persistent gate note. Cards show
before/after side-by-side, target (`product / variant`), the action label ("Replace featured image
· prior saved"), a status chip, and per-state actions (pending → Approve/Reject; approved →
Reject; published → Revert). Bulk bar: "Approve & publish (N)".

```
Review & publish      1 pending · 1 approved · 0 published
🛡 Nothing reaches a live store without approval — automated pipelines stage here too.
┌─ Linen Tee · Pending review ─────────────┐  ┌─ Wool Coat · Approved ───────────────┐
│  [before]        [after]                  │  │  [before]        [after]              │
│  Linen Tee / All variants                 │  │  Wool Coat / Charcoal / M             │
│  ⤬ Replace featured image · prior saved   │  │  ⤬ Replace image #2 · prior saved     │
│                        [Reject][Approve]  │  │                            [Reject]   │
└───────────────────────────────────────────┘  └───────────────────────────────────────┘
                                       [ Reject ]  [ Approve & publish (N) ]
```

### 8.5 Headless / automation
The same import→edit→stage operations must be invocable programmatically (an API and/or
graph-node equivalents like `LoadShopifyMedia` / `StageToShopify`). Automated stage calls enqueue
into the **same review ledger** — they do not auto-publish (decision #7).

---

## 9. Canonical UI copy

The prototype's i18n namespace is the source of truth for wording (in the ComfyUI repo at
`src/locales/en/main.json` under the `shopifyLink` key). Key strings:

- Nav: `Connectors`, `Browse media`, `Review & publish`
- Connectors: heading `Connected services`; desc "Link a store to browse its product media in
  Comfy and publish edits back."; `Connect` / `Connected` / `Disconnect`; `Coming soon`
- Connect: `Connect Shopify`; `Store domain`; suffix `.myshopify.com`; "You'll approve access on
  Shopify. We request:"; `Read products & media` / `Write products & media`; `Continue to Shopify`
- Scope: `What media should Comfy see?`; `Status` (Active/Draft/Archived); `Media role`
  (Featured only / All images / All + video/3D); `≈ {images} images across {products} products`
- Browse: `Shopify · {domain}`; `Select all` / `Clear`; `{count} selected`; `Use in workflow`;
  `Edit & stage`
- Stage: `Replace featured image` / `Replace in place`; note "Edited media is staged for review
  before it touches a live store."
- Review: `{pending} pending · {approved} approved · {published} published`; `Before (live)` /
  `After (Comfy)`; `Replace featured image · prior saved` / `Replace image #{position} · prior
  saved`; `Approve` / `Reject` / `Revert`; `Approve & publish ({count})`; gate note "Nothing
  reaches a live store without approval — automated pipelines stage here too."; state labels
  Pending review / Approved / Publishing… / Published / Rejected / Failed

(If the standalone product is not branded "Comfy," rename "After (Comfy)" / "in Comfy" accordingly.)

---

## 10. Reference prototype (in the ComfyUI frontend repo)

A clickable, mock-data, no-backend prototype exists in this worktree. **It is reference/throwaway.**
Read it to port logic and UI; do not build on top of it.

Location: `<this repo>/src/platform/shopify/`

| File | What it is | Portability |
|------|-----------|-------------|
| `types.ts` | Domain types (see §5) | **Port directly** (rename if rebranding) |
| `stagingMachine.ts` | Pure review-gate transitions (see §6) | **Port directly** — this is the spec |
| `stagingMachine.test.ts` | 6 unit tests proving the gate | **Port** — encodes the invariants |
| `fixtures/mockShopifyData.ts` | Mock catalog + picsum images | Replace with real Admin API data |
| `composables/useShopifyLink.ts` | Shared client state + actions (connect, scope, select, stage, approve/reject/publish/revert) | Port the *logic*; back it with real API calls instead of in-memory refs |
| `components/ShopifyLinkPrototype.vue` | Container + left nav (Connectors/Browse/Review) | Port as layout reference |
| `components/ShopifyConnectorsPanel.vue` | Connected-services list + scope editor | Port |
| `components/ConnectShopifyDialog.vue` | Shop-domain entry + (simulated) OAuth | Replace simulated connect with real OAuth redirect |
| `components/ShopifyMediaBrowser.vue` | Browse/select grid + stage action bar | Port |
| `components/ShopifyReviewQueue.vue` | Review list + bulk approve/publish | Port |
| `components/ShopifyReviewCard.vue` (+ `.test.ts`) | Before/after card + per-state actions | Port |
| `components/ShopifyStatusChip.vue` | Status pill | Port |
| `ShopifyPrototypeView.vue` | Full-screen wrapper | Glue only |
| `prototypeEntry.ts` | Standalone mount (Vue + local i18n) | Glue only |

Standalone serving (so it renders without a ComfyUI backend):
- `<repo>/shopify.html` — standalone HTML entry.
- `<repo>/vite.prototype.config.mts` — minimal Vite config (vue + tailwind, no proxy/bootstrap).
- `package.json` script: `pnpm dev:shopify` → serves `http://localhost:6100/shopify.html`.

**Run it:** `pnpm dev:shopify` then open `http://localhost:6100/shopify.html`.

### Why a standalone server was needed (lesson for the new project)
The ComfyUI dev server (a) proxies `/api/*` to a ComfyUI backend (returns 502 without one, which
hangs the SPA on its splash screen forever), and (b) returns the SPA shell for *every* browser
navigation. Both made it impossible to view a prototype page inside that app without a backend.
The fix was a separate minimal Vite server. **In the standalone project this is moot** — you own
the whole app and won't have those constraints.

### What the prototype STUBS (and the real project must build)
- **OAuth is simulated** (instant connect; no redirect, token exchange, or HMAC). → Real Shopify
  OAuth + the broker.
- **Editing is faked** (the "after" image is just a grayscale picsum of the "before"). → Real
  generation-provider integration.
- **No backend / no persistence** — all state is in-memory in a composable singleton. → Real
  broker with a DB for token custody + staging ledger.
- **Scope UI only exposes status + media-role.** Collection/tag filtering exists in the data model
  (`matchesScope`) but isn't wired to UI controls yet. → Add collection + tag pickers.
- **Local-vs-cloud / broker is conceptual** in the prototype. → Implement for real.
- **Push-back is not implemented** (no Shopify mutations); the snapshot-for-revert is modeled in
  types but not exercised. → Implement mutations + revert.

---

## 11. Shopify integration details (verify against the current Shopify API version)

> Confirm specifics against current Shopify docs/API version before implementing; APIs evolve.

### OAuth (one-click)
- Register a Shopify **app** (Partner dashboard). Public app (App Store) or custom app. Configure
  the redirect URI(s) to the broker callback.
- Scopes: **`read_products`** (catalog + media). Add **`write_products`** for push-back. (Avoid
  over-requesting; `read_product_listings` is for sales-channel/storefront contexts, not needed
  for Admin reads.)
- Flow: client enters `shop` → broker redirects to
  `https://{shop}/admin/oauth/authorize?client_id=…&scope=…&redirect_uri=…&state=…&grant_options[]=`
  → user approves → Shopify calls broker callback with `code`, `hmac`, `shop`, `state`.
- Broker **verifies the HMAC** with the `client_secret`, validates `state`, then POSTs to
  `https://{shop}/admin/oauth/access_token` with `{client_id, client_secret, code}` to get an
  **offline access token**. Store it server-side, encrypted, keyed by shop.
- Never ship `client_secret` to the browser or to a user's local machine.

### Reading the catalog (Admin GraphQL API)
- `products(first, query)` with Shopify search syntax for filters (e.g. `status:active`,
  `tag:'summer'`, `collection_id:…`). Paginate via cursors; consider the **Bulk Operations API**
  for very large catalogs.
- Each product: `media(first)` → `MediaImage { id, image { url, altText, width, height } }`, plus
  `featuredMedia`. Collections via `collections`.
- **Image bytes are public** (`cdn.shopify.com`) — fetch directly for editing/preview; only the
  catalog query needs the token.

### Push-back (replace-in-place)
- Product media is **product-level**; variants associate to media.
- There is no atomic "replace media" — implement replace as: **snapshot prior media → create new
  media → reorder to the target position / set featured → delete old media** (and update
  variant↔media associations if variant-targeted). Relevant mutations (verify names/availability):
  `productCreateMedia`, `productReorderMedia`, `productDeleteMedia`,
  `productVariantAppendMedia` / `productVariantDetachMedia`, plus alt-text updates.
- Media ingestion from a URL is **asynchronous** (status `PROCESSING` → `READY`/`FAILED`); handle
  `mediaUserErrors` and poll/await readiness before reordering or deleting the old media.
- **Revert** = re-create media from `priorMediaSnapshot` (its source URL/alt/position) and reorder
  back; then delete the edited media if desired.
- Respect GraphQL **cost-based rate limits**; back off and batch.

### Webhooks (for "live-linked")
Subscribe to `products/update`, `products/delete`, etc., to keep the live-linked source fresh and
to detect drift between staged "before" snapshots and current live media (warn if a listing
changed under a pending edit).

---

## 12. Pluggable connector abstraction

Shopify is connector #1. Design a `MediaSourceConnector` interface so others slot in:

```
interface MediaSourceConnector {
  id, displayName
  connect(): OAuth/credential flow
  listContainers(): collections/folders/albums
  listItems(scope): products/files with media
  getMediaUrls(item): public/temporary URLs
  // write-capable connectors only:
  stageWriteTargets(item): valid targets (e.g. product/variant/position)
  publish(stagingItem): perform the mutation (with prior-state snapshot)
  revert(stagingItem): restore prior state
}
```
Targets after Shopify: WooCommerce, Google Drive, Dropbox, S3, generic URL import. The staging
ledger and review UI are **connector-agnostic**; only the read/write adapters differ.

---

## 13. "Works locally or over the API" — generation provider abstraction

Mirror the connector idea for the editing engine:

```
interface GenerationProvider {
  id, displayName
  edit(input: ImageRef, recipe: EditRecipe): Promise<ImageRef[]>  // "after" images
  capabilities(): which recipes/operations are supported
}
```
First providers: **Comfy Cloud API** (hosted) and **local ComfyUI** (user's machine). The review
pipeline consumes provider output and never depends on which provider ran. Editing recipes are
e-commerce oriented (background swap/removal, relight, upscale, variant/colorway generation,
cleanup). Keep recipes serializable so headless pipelines can request them.

---

## 14. Recommended tech stack for the standalone project

The reference prototype is Vue 3.5 + TypeScript + Tailwind 4 + Reka UI + vue-i18n. **Reusing that
frontend stack lets you port the prototype components almost verbatim** — strongly recommended
unless there's a reason to diverge.

- **Frontend:** Vue 3.5 (`<script setup>`, Composition API), TypeScript, Tailwind 4, Reka UI / a
  shadcn-style component set, vue-i18n. (The prototype's `cn()` helper, button/input primitives,
  and semantic color tokens can be reproduced or replaced.)
- **Backend (the broker):** Node + TypeScript (Fastify/Express, or Next.js route handlers / Nuxt
  server if you want one framework). Responsibilities: OAuth, encrypted token storage, Shopify
  Admin API client, staging ledger, webhooks, write proxy, the public API for headless use.
- **Datastore:** a real DB (Postgres recommended) for: connected stores, encrypted tokens, sync
  profiles, and the staging ledger (with prior-media snapshots + audit trail). Object storage for
  edited image bytes if you persist them.
- **Auth (app users):** your own user/session + multi-store ownership (agencies → many stores;
  enforce per-store access).
- **Generation:** HTTP client(s) implementing `GenerationProvider` for Comfy Cloud API and a local
  ComfyUI endpoint.

Carry over the prototype's quality bar: typed everything (no `any`), i18n for all copy, behavioral
tests on the state machine and review UI, small modules, immutable transitions.

---

## 15. Security considerations

- **`client_secret` lives only on the broker.** Never in the browser, never on a user's machine.
- **Verify OAuth HMAC** on the callback; validate `state` (CSRF).
- **Encrypt access tokens at rest**, scope-minimized (`read_products`, add `write_products` only
  for write-enabled stores).
- **Authorize every store action** against the requesting user (agency multi-tenant isolation).
- **Destructive writes are gated** (review) and **reversible** (prior-media snapshot). Log an audit
  trail of who approved/published/reverted what and when.
- **Webhook verification** (HMAC) on inbound Shopify webhooks.
- Respect Shopify **rate limits**; never log tokens; sanitize any user-provided HTML/alt text.
- Local-token mode (opt-in): scope-limited, stored encrypted on the user's machine, clearly
  surfaced as higher-exposure.

---

## 16. Suggested build roadmap (phases)

1. **Foundations:** repo + frontend stack + backend skeleton + DB schema (stores, tokens, profiles,
   staging items). Port `types.ts` + `stagingMachine.ts` (+ tests).
2. **Connect (real OAuth):** Shopify app registration, broker OAuth handshake + token custody,
   Connectors UI wired to real connect/disconnect, multi-store.
3. **Scope + Browse:** Admin API catalog reads, sync profiles (incl. collection/tag filters), the
   media browser against real data (CDN thumbnails), live in-scope counts.
4. **Edit:** `GenerationProvider` interface + first provider (Comfy Cloud API and/or local
   ComfyUI); recipe selection; produce "after" images.
5. **Stage + Review:** staging ledger persisted server-side; review queue + cards wired to it; the
   gate enforced server-side.
6. **Publish + Revert:** Shopify write proxy (replace-in-place with snapshot), async media
   readiness handling, failure/retry, one-click revert; audit trail.
7. **Headless API:** expose import→edit→stage as a programmatic API (and/or graph nodes); confirm
   automated runs stage (never auto-publish).
8. **Live-linked freshness:** webhooks + drift detection.
9. **Pluggability hardening:** second connector and/or second generation provider to validate the
   abstractions.

---

## 17. Open questions for the new project

- **Branding / naming** (the prototype copy says "Comfy"; rename if standalone-branded).
- **Pricing/tenancy model** (per-store? per-seat? agency tiers?) — shapes auth + data model.
- **Edited-image custody:** persist edited bytes in your object storage, or push straight to
  Shopify and keep only references?
- **Variant-level vs product-level targeting:** how granular should push-back be in v1?
  (Prototype models product-level with optional variant title; Shopify media is product-level with
  variant associations.)
- **Bulk scale:** agencies/large catalogs → Bulk Operations API, queued publishing, batch review.
- **Drift policy:** if a live listing changed after an edit was staged, block publish? warn? re-base?
- **Generation provider priority:** Comfy Cloud API first, or local ComfyUI first?

---

## 18. One-paragraph orientation for the next model

You are building **Shopify Link**, a standalone web app (frontend + a "broker" backend) that links
a merchant's Shopify store via one-click OAuth, lets them browse and AI-edit product images
(delegating generation to a pluggable provider such as Comfy Cloud or a local ComfyUI), and
publishes approved edits back to live listings **only after a mandatory human review gate** —
which even headless/automated pipelines must pass through. Architecture splits a server-side
**control plane** (OAuth, token custody, catalog metadata, staging ledger, write proxy) from a
**data plane** where image bytes are read directly from Shopify's public CDN and writes route
through the broker. Push-back is replace-in-place but reversible via a prior-media snapshot. A
working mock-data prototype (Vue 3 + Tailwind) exists in the ComfyUI frontend repo under
`src/platform/shopify/` — port its `types.ts`, `stagingMachine.ts` (+ tests), and components;
replace the simulated OAuth, faked editing, and in-memory state with the real broker, generation
provider, and persistence described above.
