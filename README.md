<div align="center">

<img width="84" alt="Comfy Commerce" src="docs/assets/icon.png" />

# Comfy Commerce

### AI Product-Media Studio for Shopify

[![License](https://img.shields.io/badge/License-MIT-181818)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-3a424d?logo=node.js&logoColor=white)](https://nodejs.org)
[![Built for Comfy Cloud](https://img.shields.io/badge/Engine-ComfyUI%20%C2%B7%20Comfy%20Cloud-535c65)](https://docs.comfy.org/development/cloud/overview)

<br />

Link a Shopify store and edit or create new product images, videos or 3D assets with ComfyUI,<br />
review every change side-by-side, and publish approved results back to the live listing.<br />

Local &nbsp;&bull;&nbsp; BYO Shopify app &nbsp;&bull;&nbsp; MIT

<br />

[**Shopify setup**](docs/SHOPIFY_SETUP.md) &nbsp;&bull;&nbsp; [API reference](docs/API.md) &nbsp;&bull;&nbsp; [Comfy Cloud](https://docs.comfy.org/development/cloud/overview)

<br />

https://github.com/user-attachments/assets/46e76bd7-c635-4266-a998-9df7d28644f2

</div>


> **Note:** This is a personal hobby project. It works end to end, but expect rough edges. This is not an official ComfyUI product.

## Run ComfyUI Workflows against your product catalog

A local studio that runs ComfyUI workflows over your Shopify product media (images, video, and 3D)
in bulk, then routes every result through a mandatory review gate before it reaches the live store.

I built this to demonstrate the flexibility of the ComfyUI as a developer platform, it works end to end, is agent friendly, and is MIT licensed. So feel free to fork this as a base for your own commercial product, or contribute to the code. 

- **Edit with any ComfyUI workflow:** use the built-in workflows, or upload your own
- **Run on your terms:** local ComfyUI, remote ComfyUI, or Comfy Cloud
- **Batch across the catalog:** a selection, whole products, or every in-scope image
- **Review before anything goes live:** side-by-side or wipe compare, approve or reject, one-click revert
- **Arrange the gallery:** reorder existing and new media, or replace images in place
- **Searchable library:** caption and tag media with a VLM
- **Drive it headless:** the same REST API the UI uses, with the human gate still enforced

## Generation engines

| Engine | Setup | Notes |
|:-------|:------|:------|
| **Local ComfyUI** | run ComfyUI on `COMFY_LOCAL_URL` (default `:8188`) | Images never leave your machine; built-ins need a checkpoint installed |
| **Remote ComfyUI** | set its URL on the Connectors page → Configure | A ComfyUI on another machine on your LAN or VPN |
| **Comfy Cloud** | set `COMFY_CLOUD_API_KEY` | Uses the [Comfy Cloud API](https://docs.comfy.org/development/cloud/overview); requires a paid plan |

Pick the engine per run; the Connectors page shows live availability.

## Download

Grab the latest installer from the [**Releases**](https://github.com/shrimbly/comfy-commerce/releases/latest) page:

- **macOS** (Apple Silicon): the `.dmg`
- **Windows** (x64): the `Setup .exe`

Intel Macs and Linux aren't built; [build from source](#build-from-source) for those.

The macOS build is signed and notarized — it opens like any other app. The Windows build is
unsigned, so click **More info → Run anyway** on the SmartScreen prompt.

You'll need a generation engine (local or remote ComfyUI, or a Comfy Cloud key) and, to publish to a
real store, your own Shopify app: see [Going live with Shopify](#going-live-with-shopify). There's no
auto-update yet; grab a newer release to upgrade.

## Build from source

Requires Node.js **≥ 20** and [pnpm](https://pnpm.io) **10+** (`corepack enable`).

```bash
pnpm install
pnpm dev      # hot-reload dev servers: broker on :4000, web on :5180
pnpm build    # typecheck + build the web UI into web/dist
pnpm start    # single process serves the API and UI on :4000
pnpm test     # all workspaces
```

Copy [`.env.example`](.env.example) to `.env` to override defaults.

## Going live with Shopify

Comfy Commerce is **bring-your-own-app**: you create your own Shopify app from the
[`shopify.app.toml`](shopify.app.toml) template. Setup is easy and takes only a couple of minutes,
all from the Connect dialog in the app, so you have full control of the shopify integration.

The recommended path is **App credentials**: create an app at
[dev.shopify.com](https://dev.shopify.com) with scopes `read_products`, `write_products`,
`write_files`, then paste its Client ID and secret into **Connect → App credentials**. OAuth also works.
Full walkthrough: [docs/SHOPIFY_SETUP.md](docs/SHOPIFY_SETUP.md).

Every publish snapshots the prior media first, so each one has a one-click **Revert**.

## Workflows

Upload any ComfyUI workflow.json exported with your inputs and outputs selected in App Mode (recommended), `Export` or `Export (API)`.
Uploads auto-bind the input photo and the output node, and you choose which inputs to expose as
parameters; COMBO inputs become dropdowns. A workflow runs against a selection, whole products, or
the entire in-scope catalog, streaming results into the review queue as they finish.

## Headless API

The web UI and automated pipelines share one REST API ([docs/API.md](docs/API.md)). Automated jobs
auto-stage into the same review queue; a human approves before anything publishes.

## Security

- The broker binds to `127.0.0.1`. If you expose it, front it with an authenticating proxy (there
  are no user accounts), and set `BROKER_API_TOKEN` to require a bearer token on `/api/*` — for the
  studio and headless callers alike. The studio asks for the token on first load and keeps it in
  the browser; the desktop app manages its own token automatically.
- `SHOPIFY_API_SECRET` stays in the broker, never the browser. OAuth callbacks and webhooks are HMAC-verified.
- Access tokens are encrypted at rest (AES-256-GCM) via `DATA_DIR/secret.key` or `TOKEN_ENCRYPTION_KEY`.

## License

[MIT](LICENSE)
