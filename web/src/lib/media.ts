/** Rewrite a Shopify CDN image URL to a size-constrained variant for grid
 * tiles. The catalog stores original-resolution upload URLs; grid cells render
 * at ~150–250px, so the full download + decode is pure waste — and on a cold
 * cache it lands inside the page-transition window, re-rastering the animating
 * layer per image. Only cdn.shopify.com is rewritten (its image endpoints
 * accept a `width` param); mock /mock-cdn and /api/assets URLs pass through.
 * Never feed the rewritten URL to runs or publishes — only to <img> src. */
/* 960 covers the largest grouped-view tile (~222px CSS, aspect-square) at 2x
 * retina even for 16:9 landscape originals under object-cover — no upscaling,
 * so tiles stay as sharp as the full-resolution originals they replace. */
export function gridPreviewUrl(url: string, width = 960): string {
  try {
    const u = new URL(url, window.location.origin)
    if (u.hostname !== 'cdn.shopify.com') return url
    u.searchParams.set('width', String(width))
    return u.toString()
  } catch {
    return url
  }
}
