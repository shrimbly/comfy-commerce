# Comfy Commerce — Headless API

Everything the web UI does is available over REST on the broker (default `http://localhost:4000`).
Automated pipelines use the same endpoints — and land in the same review queue. There is no
API path that bypasses approval.

Requests from the web UI carry `x-comfy-commerce-client: web`; omit it and staged items are
attributed `via API` in the review queue.

If the broker is started with `BROKER_API_TOKEN` set, every `/api/*` call must send
`Authorization: Bearer <token>` — except `GET /api/health`, the HMAC-verified OAuth callback and
webhook routes, and read-only media GETs. The web UI sends the same header (the token is entered
once in the studio's unlock dialog), and `GET /api/health` additionally reports
`authRequired: true` so clients can detect a gated broker. When it is unset (the default), the
broker is open.

## Connect

```
GET  /api/connect/shopify/config        → { mode: "live" | "mock", scopes }
POST /api/connect/shopify { shop }      → { kind: "connected", store }            (mock mode)
                                        → { kind: "redirect", url }               (live mode — open in browser)
POST /api/connect/shopify/credentials   → { kind: "connected", store }
     { shop, clientId, clientSecret }     connect a Dev Dashboard app (2026+) —
                                          client-credentials grant, 24h tokens
                                          auto-refreshed by the broker
POST /api/connect/shopify/token         → { kind: "connected", store }
     { shop, accessToken }                connect with a legacy custom-app
                                          Admin API token (shpat_…) — verified,
                                          scope-checked, encrypted at rest
GET  /api/stores                        → { stores: ConnectedStore[] }
DELETE /api/stores/:id                    removes the store + its staging items, runs,
                                          AI captions/tags, and audit history
                                          (the live Shopify store is untouched)
```

## Liveness

```
GET /api/health   → { ok, name, authRequired }   always open; never hits the network
GET /api/status   → { ok, db, engines, … }       readiness/diagnostics — pings engines,
                                                 so treat as on-demand, not a poll target
```

## Scope & catalog

```
PATCH /api/stores/:id/scope          body: ScopeProfile     → { store, counts }
POST  /api/stores/:id/scope-preview  body: ScopeProfile     → { products, images }
GET   /api/stores/:id/catalog        → { collections, tags, counts, products, scopeProfile }
```

`ScopeProfile`:

```json
{
  "collectionIds": "all",
  "tags": [],
  "productStatus": "active",
  "mediaRole": "featured"
}
```

## Workflows

ComfyUI workflows are the editing unit. Ready-made ComfyUI graphs ship as
immutable built-ins; upload your own as API-format JSON ("Export (API)" in
ComfyUI) or the editor save format. Any workflow can be downloaded back as
ComfyUI-loadable JSON.

```
GET    /api/workflows               → { workflows }  built-ins + uploads, with per-engine compatibility
GET    /api/workflows/:id/download  → ComfyUI workflow JSON (attachment; editor format)
POST   /api/workflows/inspect   { graph }        → binding candidates + auto-binding + param candidates
POST   /api/workflows           → 201 { workflow }
{
  "name": "Studio restyle",
  "graph": { …API-format ComfyUI graph… },
  "inputNodeId": "2",            // optional — auto-bound when the graph has one LoadImage
  "outputNodeId": "9",           // optional — SaveImage preferred over PreviewImage
  "params": [                    // optional run-time params bound to node inputs
    { "id": "prompt", "label": "Prompt", "type": "text",
      "nodeId": "4", "inputKey": "text", "defaultValue": "studio photo" }
  ]
}
DELETE /api/workflows/:id        (user workflows only)
```

## Runs

A run executes one workflow over a target — a selection, products, or the
**entire in-scope catalog** (defined by the store's scope profile). Results
stream into the review queue as `pending` while the run progresses.

```
GET  /api/providers        → { providers }  mock · comfy-local · comfy-remote · comfy-cloud
                                            (live availability per engine)
POST /api/runs/estimate    { storeId, target } → { images, products }

POST /api/runs             → 202 { run }
{
  "storeId": "…",
  "workflowId": "builtin:relight",        // or an uploaded workflow id
  "providerId": "comfy-local",
  "params": { "mood": "golden-hour" },
  "target": { "kind": "catalog" },        // | {kind:"products", productIds:[…]}
                                          // | {kind:"selection", inputs:[{productId, mediaId}]}
  "stageAction": "replace-position",      // | "add-featured" (insert at the featured slot,
                                          //   prior featured shifts down)
                                          // | "add-new" (append to the listing)
  "sampleSize": 5                         // optional: test run spread across products
}

GET  /api/runs/:id          → { run }   queued → running → completed | failed | cancelled
                                        per-image items: pending → editing → done | failed

GET  /api/runs?storeId=…
POST /api/runs/:id/cancel
POST /api/runs/:id/skip-current   abort only the in-flight image; the batch continues
POST /api/runs/:id/retry          → 202 { run }  new run over the failed items
POST /api/runs/:id/promote        sample run → full run over the remaining target
DELETE /api/runs/:id              clear a finished run from history (cancel active runs first)
```

## Staging & the gate

```
GET  /api/staging?storeId=…   → { items, counts }
POST /api/staging             → 201 { items }  stage pre-edited media directly
                                               (same pending-only rule)
{
  "storeId": "…",
  "items": [
    { "productId": "…", "mediaId": "…", "afterUrl": "https://…",
      "action": "replace-position",              // | "add-featured" | "add-new"
      "mediaType": "image",                      // optional: | "video" | "model3d"
      "variantTitle": null, "recipeId": null }   // optional
  ]
}
POST /api/staging/approve     { ids }   pending  → approved
POST /api/staging/reject      { ids }   pending|approved|failed → rejected
POST /api/staging/publish     { ids }   approved → published    ← THE GATE
POST /api/staging/revert      { ids }   published → approved (prior media restored live;
                                        add-new items: the added media is deleted)
```

### Gallery arrangement (the second publish path — same gate)

```
GET  /api/staging/gallery?storeId=…&productId=…  → live media + approved/published items
POST /api/staging/arrangement                    save a full-gallery order
     { storeId, productId, order: [ {kind:"media", mediaId} | {kind:"staged", itemId} ] }
POST /api/staging/publish-gallery { storeId, productId }
     publishes the product's APPROVED items and applies the saved arrangement —
     pending items are never published by this path either
```

Workflows that emit **multiple outputs** (several images, video, or 3D) stage
one reviewable item per output: the first honors the run's `stageAction`, extra
outputs are staged as `add-new`. Items carry
`mediaType: "image" | "video" | "model3d"`; video and 3D publishes use
Shopify's `mediaContentType: VIDEO` / `MODEL_3D`.

All four return per-item results; failures never throw the batch:

```json
{ "results": [ { "id": "…", "ok": false, "state": "pending",
                 "error": "Cannot publish from 'pending' — approval is mandatory" } ] }
```

## Audit

```
GET /api/audit?storeId=…   → { entries }   stage/approve/publish/revert/connect/webhook history
```

## Other endpoints

```
GET/PATCH /api/settings                     broker settings (engine URLs, cloud key, …)
GET/POST  /api/prompts                      prompt library; PATCH/DELETE /api/prompts/:id
POST /api/assets                            upload media bytes → { id, url }
GET  /api/assets/:id                        serve an asset (read-only; exempt from the token gate)
PATCH /api/stores/:id/enrichment/tags       edit AI captions/tags   { productId, mediaId, … }
POST /api/workflows/inspect  PATCH/DELETE /api/workflows/:id        (see Workflows above)
```

## Typical automated catalog run

```bash
STORE=$(curl -s :4000/api/stores | jq -r '.stores[0].id')

# 1. upload a workflow once (or reuse a built-in / previously uploaded id)
WF=$(curl -s :4000/api/workflows -H 'Content-Type: application/json' \
  -d @my-workflow-upload.json | jq -r '.workflow.id')

# 2. run it across the entire in-scope catalog (auto-stages as pending)
curl -s :4000/api/runs -H 'Content-Type: application/json' -d "{
  \"storeId\": \"$STORE\", \"workflowId\": \"$WF\", \"providerId\": \"comfy-cloud\",
  \"params\": {}, \"target\": {\"kind\": \"catalog\"},
  \"stageAction\": \"replace-position\", \"sampleSize\": 5
}"

# 3. a human reviews in the web UI — publish is impossible until then;
#    promote the sample to the full catalog with POST /api/runs/{id}/promote
```
