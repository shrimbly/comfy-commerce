import type { Collection, Product } from '@comfy-commerce/shared'

/**
 * Seed catalog for demo stores. Media URLs point at the broker's mock CDN
 * (`/mock-cdn/...`), which renders deterministic SVG product shots.
 */

export interface MockCatalogData {
  collections: Collection[]
  products: Product[]
}

interface SeedProduct {
  id: string
  title: string
  status: 'active' | 'draft' | 'archived'
  shape: string
  collectionIds: string[]
  tags: string[]
  variants: string[]
  mediaCount: number
}

const SEED: SeedProduct[] = [
  { id: 'linen-tee', title: 'Linen Tee', status: 'active', shape: 'tee', collectionIds: ['apparel', 'summer-edit'], tags: ['summer', 'new'], variants: ['Natural / S', 'Natural / M', 'Natural / L', 'Sage / M'], mediaCount: 3 },
  { id: 'wool-hoodie', title: 'Brushed Wool Hoodie', status: 'active', shape: 'hoodie', collectionIds: ['apparel'], tags: ['winter'], variants: ['Charcoal / M', 'Charcoal / L', 'Oat / M'], mediaCount: 3 },
  { id: 'stoneware-vase', title: 'Stoneware Vase', status: 'active', shape: 'vase', collectionIds: ['home'], tags: ['new', 'ceramics'], variants: ['Sand', 'Moss'], mediaCount: 4 },
  { id: 'glazed-mug', title: 'Glazed Mug — 350ml', status: 'active', shape: 'mug', collectionIds: ['home', 'gifts'], tags: ['ceramics', 'bestseller'], variants: ['Cream', 'Slate', 'Terracotta'], mediaCount: 3 },
  { id: 'canvas-tote', title: 'Everyday Canvas Tote', status: 'active', shape: 'tote', collectionIds: ['accessories', 'summer-edit'], tags: ['summer', 'bestseller'], variants: ['Natural', 'Black'], mediaCount: 2 },
  { id: 'soy-candle', title: 'Soy Candle — Cedar & Fig', status: 'active', shape: 'candle', collectionIds: ['home', 'gifts'], tags: ['gift'], variants: ['200g', '420g'], mediaCount: 2 },
  { id: 'arc-lamp', title: 'Arc Table Lamp', status: 'active', shape: 'lamp', collectionIds: ['home'], tags: ['lighting', 'new'], variants: ['Brass', 'Matte Black'], mediaCount: 3 },
  { id: 'bouclé-cushion', title: 'Bouclé Cushion 50×50', status: 'active', shape: 'cushion', collectionIds: ['home'], tags: ['textiles'], variants: ['Ivory', 'Ochre'], mediaCount: 2 },
  { id: 'rib-knit-tee', title: 'Rib Knit Tee', status: 'draft', shape: 'tee', collectionIds: ['apparel'], tags: ['preview'], variants: ['Ecru / M'], mediaCount: 2 },
  { id: 'heritage-mug', title: 'Heritage Mug (2019)', status: 'archived', shape: 'mug', collectionIds: ['home'], tags: [], variants: ['Cream'], mediaCount: 1 },
]

const COLLECTIONS: Collection[] = [
  { id: 'apparel', title: 'Apparel' },
  { id: 'home', title: 'Home Goods' },
  { id: 'accessories', title: 'Accessories' },
  { id: 'gifts', title: 'Gifts' },
  { id: 'summer-edit', title: 'The Summer Edit' },
]

export function buildMockCatalog(): MockCatalogData {
  const products: Product[] = SEED.map((seed) => ({
    id: seed.id,
    title: seed.title,
    status: seed.status,
    collectionIds: seed.collectionIds,
    tags: seed.tags,
    variants: seed.variants.map((title, i) => ({ id: `${seed.id}-v${i + 1}`, title })),
    media: Array.from({ length: seed.mediaCount }, (_, i) => ({
      id: `${seed.id}-m${i + 1}`,
      url: `/mock-cdn/${seed.id}/${i + 1}.svg?shape=${seed.shape}`,
      altText: `${seed.title} — photo ${i + 1}`,
      position: i + 1,
    })),
  }))
  return { collections: COLLECTIONS, products }
}
