/**
 * Seed the connected Shopify store with products from a folder of images.
 *
 *   pnpm tsx scripts/seed-products.ts /path/to/images
 *
 * Uses the broker's own encrypted credentials (and its token refresh), pushes
 * image bytes via staged uploads, and creates ACTIVE products so they fall
 * inside the default scope profile. Run from the server/ directory.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { createAccessTokenResolver } from '../src/connectors/index.js'
import { shopifyGraphql } from '../src/connectors/shopify/graphql.js'
import { createDb } from '../src/db/client.js'
import { stores } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: pnpm tsx scripts/seed-products.ts <image-folder>')
  process.exit(1)
}

/** title → image files, in media order (first = featured). */
const PRODUCTS: Array<{ title: string; files: string[] }> = [
  { title: 'Workflow Engine Tee — Black', files: ['-.png'] },
  { title: 'Workflow Engine Tee — Bone', files: ['--1.png'] },
  { title: 'Spaghetti Tee — Black', files: ['Back.png'] },
  { title: 'Spaghetti Tee — Grape', files: ['Purple.png', 'Purple-2.png'] },
  { title: 'Hologram Tee — Black', files: ['Back-1.png', 'Back-2.png'] },
  { title: 'Voxel Tee — Black', files: ['Back-4.png', 'Back-3.png'] },
  { title: 'Voxel Tee — Grape', files: ['Purple-1.png'] },
  { title: "Artists' Tool Tee — Chrome", files: ['Back1.png'] },
  { title: "Artists' Tool Tee — Postcard", files: ['Back-11.png'] },
  { title: "Artists' Tool Tee — Floral", files: ['Back-21.png'] },
  { title: "Artists' Tool Tee — Botanical", files: ['Back-31.png'] },
  { title: "Artists' Tool Tee — Camo", files: ['Back-41.png'] },
  { title: "Artists' Tool Tee — Sunset", files: ['Back-51.png'] },
  { title: "Artists' Tool Tee — Brushstroke", files: ['Back-61.png'] },
]

const env = loadEnv()
const db = createDb(env.databasePath)
const getAccessToken = createAccessTokenResolver(db, env)

const store = db.select().from(stores).where(eq(stores.adapter, 'shopify')).get()
if (!store) {
  console.error('No real Shopify store connected — connect one in the UI first.')
  process.exit(1)
}

const gql = async <T>(query: string, variables?: Record<string, unknown>) =>
  shopifyGraphql<T>({
    shop: store.domain,
    accessToken: await getAccessToken(store),
    apiVersion: env.shopify.apiVersion,
    query,
    variables,
  })

async function stagedUpload(file: string): Promise<string> {
  const bytes = readFileSync(path.join(dir!, file))
  const filename = file.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/^[_.-]+/, 'img-')
  const data = await gql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string
        resourceUrl: string
        parameters: Array<{ name: string; value: string }>
      }>
      userErrors: Array<{ message: string }>
    }
  }>(
    `mutation Staged($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType: 'image/png',
          httpMethod: 'POST',
          resource: 'PRODUCT_IMAGE',
          fileSize: String(bytes.length),
        },
      ],
    },
  )
  if (data.stagedUploadsCreate.userErrors.length) {
    throw new Error(data.stagedUploadsCreate.userErrors.map((e) => e.message).join('; '))
  }
  const target = data.stagedUploadsCreate.stagedTargets[0]!
  const form = new FormData()
  for (const p of target.parameters) form.append(p.name, p.value)
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename)
  const upload = await fetch(target.url, { method: 'POST', body: form })
  if (!upload.ok && upload.status !== 201) {
    throw new Error(`staged upload failed: ${upload.status} ${await upload.text()}`)
  }
  return target.resourceUrl
}

async function createProduct(title: string, sources: string[]): Promise<string> {
  const data = await gql<{
    productCreate: {
      product: { id: string } | null
      userErrors: Array<{ field: string[] | null; message: string }>
    }
  }>(
    `mutation Create($product: ProductCreateInput!, $media: [CreateMediaInput!]!) {
      productCreate(product: $product, media: $media) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      product: {
        title,
        status: 'ACTIVE',
        vendor: 'Comfy',
        productType: 'T-Shirt',
        tags: ['merch', 'tee'],
      },
      media: sources.map((originalSource) => ({
        originalSource,
        alt: title,
        mediaContentType: 'IMAGE',
      })),
    },
  )
  if (data.productCreate.userErrors.length) {
    throw new Error(data.productCreate.userErrors.map((e) => e.message).join('; '))
  }
  if (!data.productCreate.product) throw new Error('productCreate returned no product')
  return data.productCreate.product.id
}

console.log(`Seeding ${PRODUCTS.length} products into ${store.domain}\n`)
let failed = 0
for (const spec of PRODUCTS) {
  try {
    const sources: string[] = []
    for (const file of spec.files) sources.push(await stagedUpload(file))
    const id = await createProduct(spec.title, sources)
    console.log(`✓ ${spec.title}  (${spec.files.length} image${spec.files.length > 1 ? 's' : ''})  ${id}`)
  } catch (err) {
    failed += 1
    console.error(`✗ ${spec.title}: ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`\nDone — ${PRODUCTS.length - failed} created, ${failed} failed.`)
process.exit(failed ? 1 : 0)
