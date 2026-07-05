/**
 * Mock CDN image generator.
 *
 * Renders deterministic, elegant SVG "product photos" so mock mode works
 * fully offline. An edit (recipe=workflow) restyles the render — different
 * palette + a light sweep — so before/after comparisons in the review queue
 * are visibly real.
 */

/* ── seeded randomness ─────────────────────────────────────────── */

function hash(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return (h ^= h >>> 16) >>> 0
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ── palettes & shapes ─────────────────────────────────────────── */

interface Palette {
  bgTop: string
  bgBottom: string
  product: string
  productDeep: string
  accent: string
  floor: string
}

const PALETTES: Palette[] = [
  { bgTop: '#F6F4F0', bgBottom: '#E7E2D8', product: '#C2B8A8', productDeep: '#A2967F', accent: '#8A8071', floor: '#CFC8BA' },
  { bgTop: '#EEF1EB', bgBottom: '#D8E0D1', product: '#9CAE94', productDeep: '#7D9173', accent: '#5F7257', floor: '#C2CDB9' },
  { bgTop: '#F6EEE7', bgBottom: '#E9D6C6', product: '#C97B5A', productDeep: '#AC6043', accent: '#8E4D34', floor: '#D9BCA6' },
  { bgTop: '#EDF0F3', bgBottom: '#D5DCE4', product: '#768495', productDeep: '#5B6878', accent: '#46505E', floor: '#BFC8D3' },
  { bgTop: '#F7EFEE', bgBottom: '#ECD8D4', product: '#D2998F', productDeep: '#B57A6F', accent: '#96604F', floor: '#DDC0BA' },
  { bgTop: '#F6F0E2', bgBottom: '#EADCBE', product: '#CDA14E', productDeep: '#AF8336', accent: '#8C6826', floor: '#D9C8A0' },
  { bgTop: '#ECEEF5', bgBottom: '#D6DAEA', product: '#7B84AC', productDeep: '#5E6890', accent: '#49527A', floor: '#C2C8DD' },
]

type ShapeKind = 'tee' | 'vase' | 'mug' | 'tote' | 'candle' | 'lamp' | 'hoodie' | 'cushion'

/** Each shape draws centered around (600, 640) in a 1200×1200 viewBox. */
const SHAPES: Record<ShapeKind, (fill: string, deep: string, accent: string) => string> = {
  tee: (fill, deep) => `
    <path d="M460 380 L540 340 Q600 380 660 340 L740 380 L820 470 L740 545 L728 480 L728 880 Q600 910 472 880 L472 480 L460 545 L380 470 Z" fill="${fill}"/>
    <path d="M540 340 Q600 380 660 340 L646 362 Q600 396 554 362 Z" fill="${deep}"/>
    <path d="M472 740 Q600 768 728 740 L728 880 Q600 910 472 880 Z" fill="${deep}" opacity="0.18"/>`,
  hoodie: (fill, deep, accent) => `
    <path d="M450 400 L545 345 Q600 320 655 345 L750 400 L830 500 L745 570 L735 505 L735 885 Q600 915 465 885 L465 505 L455 570 L370 500 Z" fill="${fill}"/>
    <path d="M545 345 Q600 300 655 345 Q660 410 600 425 Q540 410 545 345 Z" fill="${deep}"/>
    <path d="M560 430 L575 600 M640 430 L625 600" stroke="${accent}" stroke-width="14" stroke-linecap="round" fill="none"/>
    <path d="M465 760 Q600 790 735 760 L735 885 Q600 915 465 885 Z" fill="${deep}" opacity="0.2"/>`,
  vase: (fill, deep) => `
    <path d="M560 330 L640 330 L630 410 Q760 470 755 640 Q750 830 600 845 Q450 830 445 640 Q440 470 570 410 Z" fill="${fill}"/>
    <path d="M600 845 Q450 830 445 640 Q442 520 520 450 Q470 560 505 690 Q540 820 600 845 Z" fill="${deep}" opacity="0.45"/>
    <ellipse cx="600" cy="330" rx="40" ry="10" fill="${deep}"/>`,
  mug: (fill, deep, accent) => `
    <path d="M450 430 L750 430 L735 840 Q600 875 465 840 Z" fill="${fill}"/>
    <path d="M750 470 Q860 480 855 580 Q850 690 730 690 L738 630 Q795 630 798 575 Q800 525 745 522 Z" fill="${fill}"/>
    <ellipse cx="600" cy="430" rx="150" ry="34" fill="${deep}"/>
    <ellipse cx="600" cy="430" rx="118" ry="24" fill="${accent}" opacity="0.5"/>
    <path d="M465 760 Q600 800 735 760 L735 840 Q600 875 465 840 Z" fill="${deep}" opacity="0.25"/>`,
  tote: (fill, deep, accent) => `
    <path d="M430 470 L770 470 L815 870 Q600 905 385 870 Z" fill="${fill}"/>
    <path d="M510 470 Q510 330 600 330 Q690 330 690 470 L655 470 Q655 365 600 365 Q545 365 545 470 Z" fill="${accent}"/>
    <path d="M385 870 L430 470 L495 470 L463 878 Q420 875 385 870 Z" fill="${deep}" opacity="0.4"/>
    <line x1="455" y1="560" x2="745" y2="560" stroke="${deep}" stroke-width="10" opacity="0.45"/>`,
  candle: (fill, deep, accent) => `
    <path d="M470 460 L730 460 L730 830 Q600 865 470 830 Z" fill="${fill}"/>
    <ellipse cx="600" cy="460" rx="130" ry="30" fill="${deep}"/>
    <ellipse cx="600" cy="460" rx="100" ry="20" fill="#F2EBDD"/>
    <path d="M600 408 Q622 432 600 452 Q578 432 600 408 Z" fill="${accent}"/>
    <rect x="470" y="620" width="260" height="92" fill="#FFFFFF" opacity="0.82"/>
    <line x1="510" y1="650" x2="690" y2="650" stroke="${deep}" stroke-width="9" opacity="0.6"/>
    <line x1="540" y1="680" x2="660" y2="680" stroke="${deep}" stroke-width="7" opacity="0.4"/>`,
  lamp: (fill, deep, accent) => `
    <path d="M455 350 L745 350 L800 560 L400 560 Z" fill="${fill}"/>
    <path d="M455 350 L500 350 L450 560 L400 560 Z" fill="${deep}" opacity="0.5"/>
    <rect x="585" y="560" width="30" height="240" fill="${accent}"/>
    <path d="M460 870 Q600 840 740 870 L740 885 Q600 915 460 885 Z" fill="${deep}"/>
    <ellipse cx="600" cy="845" rx="145" ry="32" fill="${fill}"/>`,
  cushion: (fill, deep, accent) => `
    <path d="M390 480 Q600 420 810 480 Q860 660 810 840 Q600 900 390 840 Q340 660 390 480 Z" fill="${fill}"/>
    <path d="M390 480 Q600 420 810 480 Q825 540 832 600 Q600 540 368 600 Q375 540 390 480 Z" fill="${deep}" opacity="0.28"/>
    <circle cx="600" cy="660" r="16" fill="${accent}"/>
    <path d="M390 480 Q360 450 345 460 M810 480 Q840 450 855 460 M390 840 Q360 870 345 860 M810 840 Q840 870 855 860" stroke="${deep}" stroke-width="12" stroke-linecap="round" fill="none"/>`,
}

const SHAPE_KINDS = Object.keys(SHAPES) as ShapeKind[]

export interface RenderOptions {
  /** Deterministic identity of the base image, e.g. "linen-tee/1". */
  key: string
  recipe?: string | undefined
  params?: Record<string, string> | undefined
  /** Explicit shape override (mock catalog assigns shapes per product). */
  shape?: string | undefined
}

export function renderMockImage(opts: RenderOptions): string {
  const { key, recipe, params = {} } = opts
  const seed = hash(key)
  const rng = mulberry32(seed)

  const palette = PALETTES[seed % PALETTES.length]!
  const shapeKind =
    opts.shape && SHAPE_KINDS.includes(opts.shape as ShapeKind)
      ? (opts.shape as ShapeKind)
      : SHAPE_KINDS[seed % SHAPE_KINDS.length]!

  let bgTop = palette.bgTop
  let bgBottom = palette.bgBottom
  let floor = palette.floor
  let productFill = palette.product
  let productDeep = palette.productDeep
  let darkBg = false
  let decor = ''
  let overlay = ''
  let showFloorShadow = true
  let showSpecks = true
  let detailBoost = false

  /* The mock engine renders every edit as a deterministic per-workflow restyle:
     a different palette + a soft diagonal light sweep. (Base catalog images pass
     no recipe and render untransformed.) */
  if (recipe === 'workflow') {
    const wfSeed = hash(params.wf ?? 'wf')
    const wfPalette = PALETTES[(wfSeed + 3) % PALETTES.length]!
    bgTop = wfPalette.bgTop
    bgBottom = wfPalette.bgBottom
    floor = wfPalette.floor
    productFill = wfPalette.product
    productDeep = wfPalette.productDeep
    overlay = `<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1"><stop offset="35%" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.28"/><stop offset="65%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient><rect width="1200" height="1200" fill="url(#sweep)"/>`
    showSpecks = false
  }

  /* dust/blemish specks on the raw photo — removed by every edit */
  let specks = ''
  if (showSpecks) {
    for (let i = 0; i < 6; i++) {
      const x = 180 + rng() * 840
      const y = 160 + rng() * 800
      const r = 3 + rng() * 6
      specks += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="#5A5347" opacity="${(0.14 + rng() * 0.16).toFixed(2)}"/>`
    }
  }

  const detail = detailBoost
    ? `<g opacity="0.35">${SHAPES[shapeKind](`${productDeep}`, productDeep, palette.accent)
        .replaceAll('fill="', 'fill-opacity="0.0" stroke-width="3" stroke="')
        .replaceAll('<ellipse', '<ellipse fill="none"')}</g>`
    : ''

  const floorShadow = showFloorShadow
    ? `<ellipse cx="600" cy="905" rx="285" ry="46" fill="${darkBg ? '#000000' : floor}" opacity="${darkBg ? 0.35 : 0.55}"/>`
    : ''

  const shape = SHAPES[shapeKind](productFill, productDeep, palette.accent)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${bgTop}"/>
      <stop offset="100%" stop-color="${bgBottom}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="1200" fill="url(#bg)"/>
  ${decor}
  ${floorShadow}
  ${shape}
  ${detail}
  ${specks}
  ${overlay}
</svg>`
}
