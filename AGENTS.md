# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, etc.) working in this repo, and for
agents helping a user **configure the app and author ComfyUI workflows**. Humans read this
too — it doubles as the contributor guide.

## What this is

Comfy Commerce is a self-hosted, single-operator tool that links a Shopify store, AI-edits its
product media on **local ComfyUI** or **Comfy Cloud**, and publishes approved edits back to the
live listing. It is a pnpm monorepo: a **Fastify + SQLite broker** (`server/`), a **React 19 +
Vite + Tailwind 4** studio UI (`web/`), and a **pure, tested domain core** (`packages/shared/`).

The headless REST API is documented in [`docs/API.md`](docs/API.md); the architecture overview is
in [`README.md`](README.md).

## The cardinal rule — never bypass the review gate

**Nothing reaches a live store without a human approval step.** This is the product's entire
reason to exist. The states and types live in `packages/shared/src/staging.ts`; the gate itself
is the atomic SQL claim in `server/src/services/stagingService.ts` (`publishOne`), covered by
`server/test/gateClaim.test.ts`:

- `stage` **always** creates `pending` items — UI and headless API alike.
- `publish` transitions **only** `approved → published` (plus the `failed → publishing` retry of
  an already-approved item). Publishing a `pending` item must fail.
- Automated/agent-driven runs auto-stage as `pending`; a human approves before publish.

Do not add a code path, endpoint, flag, or "convenience" that lets a run publish without passing
through `approved`. If a change touches staging, update the broker service and the gate tests in
`server/test/gateClaim.test.ts` (and the shared types when the item shape changes).

## Setup

**Prerequisites**

- Node **≥ 20** and **pnpm 10.27** (pinned via `packageManager` in `package.json` — use
  `corepack enable` to get the right version).
- Optional, for real generation: a **local ComfyUI** on `http://127.0.0.1:8188`, and/or a
  **Comfy Cloud** API key. Without either, the built-in **mock engine** runs the whole pipeline
  instantly so the app is fully testable offline.

**Install & run (the working dev loop)**

```bash
pnpm install
pnpm dev            # broker on :4000, web on :5173 (Vite picks the next free port if taken)
```

Open the web app, click **Connect**, type any store name — you get a demo store backed by a mock
catalog, and the full loop works: browse → run a workflow → review → publish → revert (against the
mock catalog). No Shopify account needed to develop.

**Run in production (single command)**

```bash
pnpm build          # typecheck all packages + build the web UI into web/dist
pnpm start          # one process: broker serves the API AND web/dist on http://localhost:4000
```

`pnpm start` runs the broker via `tsx` with `SERVE_WEB=1`, so the UI and API share one origin
(no Vite, no proxy, no CORS). It serves `web/dist` with an SPA deep-link fallback. On Windows,
set `SERVE_WEB=1` in `.env` instead of relying on the inline env var.

**Verify your changes**

```bash
pnpm typecheck      # tsc --noEmit across all three packages — must be clean
pnpm test           # vitest: shared state machine + broker API/round-trip tests
pnpm build          # typecheck + production web build
```

**Useful env vars** (all optional — see `.env.example`):

- `SERVE_WEB=1` — broker serves the built web UI (set automatically by `pnpm start`).
- `BROKER_API_TOKEN` — when set, all `/api/*` calls must send `Authorization: Bearer <token>`; the
  studio prompts for the same token on first load, and the desktop shell injects its own;
  unset (default) leaves the broker open, which is fine for the localhost single-operator case.
- `RUN_CONCURRENCY` (default 2) — how many runs execute at once before the rest wait queued.
- `SHOPIFY_API_VERSION` (default `2026-01`) — keep current; Shopify supports each version ~12 months.

## What the agent needs the *user* to do

An agent can write code, author workflow JSON, and drive the REST API, but some steps require the
human operator. Ask the user to:

1. **Connect a Shopify store** (only they can create the app and click *Install*). It's done in the
   app's **Connect** dialog and takes a couple of minutes — see the full agent runbook in
   [docs/SHOPIFY_SETUP.md](docs/SHOPIFY_SETUP.md). In short: walk the user through the Dev Dashboard
   (create an app from the canonical [`shopify.app.toml`](shopify.app.toml) template with scopes
   `read_products,write_products,write_files`, install it, copy **Client ID + Client secret**), then
   have them paste those into **Connect → App credentials** — or POST the same values to
   `/api/connect/shopify/credentials`. Every install owns its own app (no shared central app). The
   connect paths are:
   - **App credentials** — Client ID + Client secret in **Connect → App credentials**. Works only
     when app and store are in the **same org** — the operator's own store.
   - **OAuth** — for multi-store/cross-org setups; set `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` in
     `.env` and restart.
2. **Provide a generation engine**: run ComfyUI locally (and install at least one checkpoint —
   most workflows need a model; pure-resize graphs run model-free), or set
   `COMFY_CLOUD_API_KEY` (from platform.comfy.org → Profile → API keys; requires a paid plan).
3. **Approve and publish** edits in the UI. The agent must never do this on the user's behalf
   without explicit, per-batch instruction — it is the human gate.
4. Fill `.env` (copy from `.env.example`) for any non-mock configuration.

## Project layout

```
packages/shared   Domain types + staging/review read-model helpers. Pure, no I/O, tested.
                  Imported by both server and web. Change types here first.
server            Fastify broker. Routes (routes/), services (services/), Shopify connectors
                  (connectors/shopify/), generation providers (providers/), SQLite (db/),
                  workflow parsing/conversion (workflows/).
web               React studio. Feature folders under src/features/, shared UI in
                  src/components/ui/, API hooks in src/api/, design tokens in src/styles/index.css.
scripts           e2e-drive.mjs — Playwright walkthrough of the full loop.
docs/API.md       The headless REST contract.
```

Connectors implement `StoreConnector` (`server/src/connectors/types.ts`); generation engines
implement `GenerationProvider` (`server/src/providers/types.ts`). Both are pluggable — add a new
file and register it, don't fork the orchestration.

## Workflows — the agent's main job

ComfyUI workflows are the first-class editing unit. Helping users build and bind them is the
primary reason an agent is in this repo.

- **Built-ins**: ready-made ComfyUI graphs ship by default and are immutable — generated into
  `server/src/workflows/builtin-graphs.ts` (by `scripts/bake-builtins.ts`) and surfaced via
  `server/src/workflows/builtins.ts`. They run and download like user workflows.
- **Uploads**: any ComfyUI workflow. The uploader accepts both **"Export (API)"** JSON and the
  **editor save format** (auto-converted at upload time, and re-converted at run time against the
  target engine's node catalog — `server/src/workflows/editor.ts`). Subgraphs are flattened.
- **Binding**: on upload the broker auto-detects which node receives the product photo
  (`LoadImage`) and which produces the result (`SaveImage` preferred over `PreviewImage`), and
  surfaces parameter candidates. The agent's job is usually to pick the right input/output nodes
  and choose which inputs to expose as run-time **params** (e.g. a prompt).
- **API**: `POST /api/workflows/inspect { graph }` returns binding candidates without saving;
  `POST /api/workflows` creates one. See `docs/API.md`.
- A run targets a **selection**, specific **products**, or the **entire in-scope catalog**. Large
  runs nudge a 5-image sample first, then one-click promote. Results stream into the review queue
  as `pending`.

When authoring a workflow for a user, prefer to validate it against their actual engine
(`GET /api/providers` shows live availability and per-engine node compatibility) before a full
catalog run, and always start with a small `sampleSize`.

## Conventions

- **TypeScript strict, ESM everywhere.** `tsconfig.base.json` sets `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Relative imports **must** carry the `.js`
  suffix (e.g. `import { loadEnv } from './env.js'`) even though the source is `.ts` — this is
  required for Node ESM and the existing code is consistent about it.
- **Validation at the edges.** Route bodies are parsed with **Zod**; the global error handler in
  `server/src/app.ts` turns `ZodError` into a 400. Errors that should reach the client with a
  specific status use `Object.assign(new Error(msg), { statusCode })`.
- **Persistence.** Drizzle over better-sqlite3. The schema is bootstrapped with idempotent DDL in
  `server/src/db/client.ts`; older databases are upgraded with **additive** `ALTER TABLE` guards
  in the same file. When you add a column, add it to `schema.ts`, the bootstrap DDL, **and** an
  additive migration guard.
- **Design system — no exceptions.** Tokens live in `web/src/styles/index.css`. Use them; do not
  hardcode hex or off-scale sizes.
  - Type: **Geist**, sizes **14 / 16 / 18** only (`text-sm` / `text-base` / `text-lg`).
  - Color: via CSS vars — `--ink` `#181818`, `--ink-soft` `#6A6A6A`, surfaces `--surface*`,
    semantic `--success/--warn/--danger/--info/--violet` (each with a `-soft` pair). Light + dark
    both defined; never reference a raw hex in a component.
  - Spacing: **4px grid**. Radius: **8–40px**. Icons (lucide-react): **18px**, **1.5** stroke,
    24px box.
- **Commits** follow Conventional Commits as observed in history: `feat:`, `fix:`, `design:`.
  Keep them atomic.

## Branching & releases

- **`develop`** is the integration branch and the default base for all work.
- **Day-to-day work happens on `feat/*` branches** cut from `develop` and merged back into
  `develop` when green (`pnpm typecheck && pnpm test`). Never commit directly to `master`.
- **`master` is release-only.** It advances exclusively by merging `develop` (use `--no-ff` so
  each release is one merge commit).
- **A push to `master` IS a release**: `.github/workflows/release.yml` builds the unsigned
  macOS + Windows installers on CI and publishes them to the GitHub release for the current
  `desktop/package.json` version — creating the release and its `v<version>` tag on first sight,
  replacing the assets on re-pushes of the same version. To cut a **new** release: bump the
  version in `desktop/package.json` (and keep the root `package.json` in step), merge
  `develop → master`, push.
- **CI** (typecheck + tests + build) runs on every PR and on pushes to `develop`, `feat/*`, and
  `master`.

## Definition of done (run before you hand back / commit)

1. `pnpm typecheck` — clean.
2. `pnpm test` — green. Add/extend tests for any staging, workflow-conversion, or connector logic.
3. If you touched the UI, check both light and dark themes and only design-token values.
4. If you touched staging/publish, re-confirm the gate: a `pending` item cannot be published.
5. Never commit secrets. `.env`, `data/`, and `secret.key` are gitignored — keep them that way.

## Gotchas

- **Mock vs live.** With no `SHOPIFY_API_KEY`/secret, `Connect` creates **mock** stores; the
  Shopify code paths are exercised only once real credentials are configured. `loadEnv` refuses to
  read `.env` under Vitest, so tests never touch live credentials.
- **Runs are async and process-local.** `runService` enqueues runs and executes up to
  `RUN_CONCURRENCY` (default 2) at once; the rest sit `queued` until a slot frees. A broker restart
  marks orphaned runs `failed` (recovered on boot); `SIGINT`/`SIGTERM` shut down gracefully,
  aborting in-flight engine jobs and recording interrupted state.
- **Demo images are SVG.** The broker rasterizes them to PNG before sending to a real engine, so
  local/cloud runs work without a real store.
- **Shopify media ingestion is async.** Publishing waits for `productCreateMedia` to reach
  `READY`; see the Shopify connector for the create → await → reorder → delete sequence.
