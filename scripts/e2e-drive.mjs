// Drives the full loop against the CURRENT UI: connect a demo store → upload
// a workflow → run it (launched via the headless API — the mock engine is no
// longer pickable in the RunSheet, and launch is gated on a real engine) →
// catalog sample run → promote → review → approve & publish → revert → dark
// theme. Screenshots land in .e2e-shots/.
//
// Boot the app first, then point BASE_URL at the web origin:
//   pnpm dev                    # broker :4000 + Vite (proxies /api)
//   BASE_URL=http://localhost:5180 node scripts/e2e-drive.mjs
// or single-origin:
//   pnpm build && pnpm start    # broker serves web/dist on :4000
//   BASE_URL=http://localhost:4000 node scripts/e2e-drive.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT = `${process.cwd()}/.e2e-shots/`
mkdirSync(OUT, { recursive: true })

const USER_GRAPH = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  2: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  3: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
  4: {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'warm editorial product photo', clip: ['1', 1] },
    _meta: { title: 'Positive prompt' },
  },
  6: {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], positive: ['4', 0], latent_image: ['3', 0], seed: 7, denoise: 0.5 },
  },
  9: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'out' } },
}

const graphFile = path.join(os.tmpdir(), 'cc-e2e-workflow.json')
writeFileSync(graphFile, JSON.stringify(USER_GRAPH))

/** Headless API client — same origin as the UI (Vite proxies /api to :4000). */
async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${await res.text()}`)
  return res.json()
}

/** Poll one run until it settles; throw unless it completed. */
async function waitForRun(runId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { run } = await api('GET', `/api/runs/${runId}`)
    if (run.state !== 'queued' && run.state !== 'running') {
      if (run.state !== 'completed') throw new Error(`Run ${runId} ended '${run.state}': ${run.error ?? ''}`)
      return run
    }
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not settle in ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Poll until NO run for the store is queued/running (e.g. after a promote). */
async function waitForAllRunsSettled(storeId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { runs } = await api('GET', `/api/runs?storeId=${storeId}`)
    if (runs.every((r) => r.state !== 'queued' && r.state !== 'running')) return runs
    if (Date.now() > deadline) throw new Error(`Runs did not settle in ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: false })
const step = (msg) => console.log(`✓ ${msg}`)

try {
  // 1. Connect a demo store if none exists. The connect dialog defaults to
  //    "App credentials" — the demo path is behind the Segmented control.
  await page.goto(`${BASE}/connectors`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800)
  await shot('01-connectors')
  if ((await api('GET', '/api/stores')).stores.length === 0) {
    await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
    await page.getByRole('radio', { name: 'Demo store' }).click()
    await page.locator('#shop-domain').fill('atelier-demo')
    await page.getByRole('button', { name: 'Connect demo store' }).click()
    // Post-connect confirmation holds a spinner ~2s, then offers Done.
    await page.getByRole('button', { name: 'Done' }).click({ timeout: 15_000 })
    step('demo store connected')
  }
  const storeId = (await api('GET', '/api/stores')).stores[0].id

  // 2. Workflows page — upload a user workflow through the stepped wizard.
  await page.goto(`${BASE}/workflows`)
  await page.waitForTimeout(900)
  await shot('02-workflows')
  if (!(await page.locator('text=Studio restyle').count())) {
    await page.getByRole('button', { name: /Upload workflow/ }).first().click()
    await page.locator('input[type=file]').setInputFiles(graphFile)
    // Step 1 · Details: name it (placeholder "e.g. Studio relight v2").
    await page.locator('input[placeholder*="Studio relight"]').fill('Studio restyle')
    await page.getByRole('button', { name: 'Next' }).click() // → Image inputs (auto-bound)
    await page.getByRole('button', { name: 'Next' }).click() // → Parameters
    // Step 3 · Parameters: expose the prompt.
    await page.locator('label', { hasText: 'Positive prompt' }).locator('input[type=checkbox]').check()
    await shot('03-upload-bound')
    await page.getByRole('button', { name: 'Save workflow' }).click()
    await page.waitForTimeout(800)
    step('user workflow uploaded with prompt param')
  }
  await shot('04-workflows-with-upload')

  // 3. Selection run on two images. Launched via POST /api/runs with the mock
  //    engine — the RunSheet filters `mock` out of its engine picker and gates
  //    launch on a real engine, so the UI can't drive this offline any more.
  const { workflows } = await api('GET', '/api/workflows')
  const restyle = workflows.find((w) => w.name === 'Studio restyle')
  if (!restyle) throw new Error('Uploaded workflow not found via API')
  const catalog = await api('GET', `/api/stores/${storeId}/catalog`)
  const inputs = catalog.products
    .slice(0, 2)
    .map((p) => ({ productId: p.id, mediaId: p.media[0].id }))
  const promptParam = restyle.params[0]
  const { run: selectionRun } = await api('POST', '/api/runs', {
    storeId,
    workflowId: restyle.id,
    providerId: 'mock',
    params: promptParam ? { [promptParam.id]: 'warm editorial product photo' } : {},
    target: { kind: 'selection', inputs },
    stageAction: 'replace-position',
  })
  step('selection run launched via API (mock engine)')
  await waitForRun(selectionRun.id)

  // 4. Activity page — a completed run shows its Review (n) call-to-action.
  await page.goto(`${BASE}/activity`)
  await page.getByRole('button', { name: /Review \(\d+\)/ }).first().waitFor({ timeout: 15_000 })
  await shot('05-activity-selection-done')
  step('selection run completed')

  // 5. Widen scope to all images so the catalog target is big enough to sample.
  await page.goto(`${BASE}/connectors`)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /Show filters/ }).click()
  const allImages = page.getByRole('radio', { name: 'All images' })
  await allImages.waitFor()
  if ((await allImages.getAttribute('aria-checked')) !== 'true') {
    await allImages.click()
    await page.getByRole('button', { name: 'Save profile' }).click()
    await page.getByRole('button', { name: 'Save profile' }).waitFor({ state: 'detached', timeout: 10_000 })
    step('scope widened to all images')
  }

  // 6. Catalog run with sample-first (via API, mock engine).
  const fit = workflows.find((w) => w.id === 'builtin:fit-to-768px')
    ?? workflows.find((w) => w.source === 'builtin')
  const { run: sampleRun } = await api('POST', '/api/runs', {
    storeId,
    workflowId: fit.id,
    providerId: 'mock',
    params: {},
    target: { kind: 'catalog' },
    stageAction: 'replace-position',
    sampleSize: 5,
  })
  await waitForRun(sampleRun.id)
  await page.goto(`${BASE}/activity`)
  await page.waitForSelector('text=Sample of', { timeout: 15_000 })
  await shot('06-activity-sample-done')
  step('catalog sample run completed')

  // 7. Promote the sample to the rest of the catalog from the activity row.
  await page.getByRole('button', { name: /^Run remaining/ }).click()
  await waitForAllRunsSettled(storeId)
  await page.waitForTimeout(800)
  await shot('07-activity-promoted')
  step('promoted run completed')

  // 8. Review — filter from the promoted run, approve & publish, revert one.
  await page.getByRole('button', { name: /Review \(\d+\)/ }).first().click()
  await page.waitForURL('**/review**')
  await page.waitForTimeout(1000)
  await shot('08-review-run-filtered')
  await page.getByRole('button', { name: /Approve & publish/ }).click()
  // Items walk pending → approved → publishing → published; the first
  // published replace-position item grows a Revert action.
  await page.getByRole('button', { name: 'Revert', exact: true }).first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(600)
  await shot('09-review-published')
  step('approved & published the filtered run')

  await page.getByRole('button', { name: 'Revert', exact: true }).first().click()
  // The reverted item lands back in `approved` — its Publish action returns.
  await page.getByRole('button', { name: 'Publish', exact: true }).first().waitFor({ timeout: 15_000 })
  step('reverted one publish')

  // 9. Activity + dark theme (the sidebar toggle is aria-labelled by intent).
  await page.goto(`${BASE}/activity`)
  await page.waitForTimeout(900)
  await shot('10-activity')
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.waitForTimeout(500)
  await shot('11-activity-dark')
  await page.goto(`${BASE}/workflows`)
  await page.waitForTimeout(900)
  await shot('12-workflows-dark')
  step('dark theme captured')

  console.log('ALL STEPS PASSED')
} catch (err) {
  await shot('99-failure')
  console.error('FAILED:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
