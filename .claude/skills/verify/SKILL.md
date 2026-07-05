---
name: verify
description: Drive the running Comfy Commerce app to verify a web/server change end-to-end — dev servers, throwaway mock store, staging via API, Playwright.
---

# Verify a change in the running app

## Handles

- Dev servers usually already running: broker on **:4000** (`server/`, tsx watch — picks up server changes), vite on **:5180** (`web/` — serves the live working tree). Check with `lsof -nP -iTCP:4000 -iTCP:5180 -sTCP:LISTEN`, confirm cwd with `lsof -p <pid> | grep cwd` (other projects also use 5173/518x).
- Cold start: root `pnpm dev` (sets WEB_PORT=5180). The vite proxy is **hardcoded to :4000** (`web/vite.config.ts`) — the broker must be on 4000.
- API is open in dev (no bearer token). Confirm mock mode before mutating anything: `GET /api/connect/shopify/config` → `{"mode":"mock"}`. **Never publish against a live-mode store.**

## Isolated test data (don't touch existing stores)

```bash
# throwaway mock store (mock mode only)
curl -X POST :4000/api/connect/shopify -H 'Content-Type: application/json' -d '{"shop":"verify-<topic>"}'
# catalog: product/media ids to stage against
curl ":4000/api/stores/<id>/catalog"
# stage items (add-featured | replace-position | add-new)
curl -X POST :4000/api/staging -d '{"storeId":"<id>","items":[{"productId":"linen-tee","mediaId":"linen-tee-m1","afterUrl":"/mock-cdn/glazed-mug/1.svg?shape=mug","action":"add-new"}]}'
# cleanup when done
curl -X DELETE :4000/api/stores/<id>
```

## Driving the UI

- Playwright is a root devDependency; from a script outside the repo, `require('<repo>/node_modules/playwright')`.
- Select the store before load: `page.addInitScript(([k,v]) => localStorage.setItem(k,v), ['cc-active-store', STORE_ID])`.
- Single header CTAs portal into the shell pill (`PageHeader` `actions`); they render fine in the real app but need the pill slot (`CtaSlotContext`) + a ResizeObserver stub in jsdom tests.
- framer-motion `Reorder` drags work with `page.mouse` — down, small nudge, then `move(..., {steps: 20+})`, pause ~250ms, up.
- Staging list polls every 5s; API-side mutations show up in the UI within that window.

## Gotchas

- The app runs in **StrictMode** — state updaters are double-invoked in dev. Vitest renders without StrictMode, so impure-updater bugs (ref writes inside `setState(fn)`) only surface in the running app. If a page renders its shell but not query-fed content, suspect this first.
- 4xx/5xx API responses don't fire Playwright `requestfailed`; log `page.on('response')` filtered to `/api/` instead.
