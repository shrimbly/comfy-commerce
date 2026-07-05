/**
 * Render the dmg installer background as the app's `.app-bg` backdrop
 * (web/src/styles/index.css): canvas + four-bloom mesh gradient + the
 * fractalNoise grain film, plus a soft drag-to-Applications arrow between
 * the icon slots. LIGHT theme by default — Finder draws the icon labels
 * (black in light appearance, white in dark) and only a light background
 * keeps them readable in both; the dark variant stays available for
 * reference:  node scripts/make-dmg-background.mjs [light|dark]
 *
 * Emits 540x380 (@1x) and 1080x760 (@2x) PNGs combined into
 * desktop/build/dmg-background.tiff (referenced by electron-builder.yml).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(repo, 'desktop', 'package.json'))
const { Resvg } = require('@resvg/resvg-js')

const W = 540
const H = 380

/* Both themes verbatim from index.css: :root and [data-theme='dark'].
   blooms: radial-gradient(RX% RY% at X% Y%, rgb / A, transparent STOP%) */
const THEMES = {
  light: {
    canvas: '#f9f8f5',
    arrowInk: '#181818',
    noise: { opacity: 0.15, blend: 'multiply' },
    blooms: [
      { rx: 0.6, ry: 0.52, x: 0.12, y: 0.04, rgb: [112, 120, 134], a: 0.17, stop: 70 },
      { rx: 0.56, ry: 0.48, x: 0.88, y: 0.0, rgb: [120, 124, 140], a: 0.15, stop: 70 },
      { rx: 0.54, ry: 0.52, x: 0.98, y: 0.98, rgb: [140, 128, 112], a: 0.14, stop: 70 },
      { rx: 0.5, ry: 0.5, x: 0.02, y: 1.0, rgb: [124, 120, 114], a: 0.13, stop: 70 },
    ],
  },
  dark: {
    canvas: '#16171c',
    arrowInk: '#f2f2f2',
    noise: { opacity: 0.07, blend: 'normal' },
    blooms: [
      { rx: 0.58, ry: 0.5, x: 0.14, y: 0.06, rgb: [185, 170, 230], a: 0.06, stop: 72 },
      { rx: 0.54, ry: 0.46, x: 0.86, y: 0.02, rgb: [143, 182, 228], a: 0.05, stop: 72 },
      { rx: 0.52, ry: 0.5, x: 0.96, y: 0.96, rgb: [216, 180, 94], a: 0.035, stop: 72 },
      { rx: 0.48, ry: 0.48, x: 0.04, y: 0.98, rgb: [143, 192, 156], a: 0.04, stop: 72 },
    ],
  },
}

const themeName = process.argv[2] ?? 'light'
const theme = THEMES[themeName]
if (!theme) {
  console.error(`Unknown theme "${themeName}" — use light or dark`)
  process.exit(1)
}

/* CSS ellipse blooms → SVG: r = rx in user units, scale(1, ry/rx) squashes,
   so the center y attr is pre-divided by that factor. */
const defs = theme.blooms
  .map((b, i) => {
    const rx = b.rx * W
    const k = (b.ry * H) / rx
    const cx = b.x * W
    const cy = (b.y * H) / k
    const color = `rgb(${b.rgb.join(',')})`
    return `<radialGradient id="m${i}" gradientUnits="userSpaceOnUse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rx.toFixed(1)}" gradientTransform="scale(1 ${k.toFixed(4)})">
      <stop offset="0%" stop-color="${color}" stop-opacity="${b.a}"/>
      <stop offset="${b.stop}%" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>`
  })
  .join('\n')

/* Same grain as .app-bg::before — fractalNoise 0.85 / 2 octaves, desaturated.
   Light multiplies dark specks onto the canvas; dark lays light specks over. */
const grain = `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`

/* Drag hint between the icon slots (130,180) → (410,180). */
const arrow = `<g transform="translate(270,180)" opacity="0.30" fill="none" stroke="${theme.arrowInk}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M -34 0 H 22" />
  <path d="M 6 -17 L 24 0 L 6 17" />
</g>`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${defs}
${grain}
</defs>
<rect width="${W}" height="${H}" fill="${theme.canvas}"/>
${theme.blooms.map((_, i) => `<rect width="${W}" height="${H}" fill="url(#m${i})"/>`).join('\n')}
<rect width="${W}" height="${H}" filter="url(#n)" opacity="${theme.noise.opacity}" style="mix-blend-mode:${theme.noise.blend}"/>
${arrow}
</svg>`

const tmp = mkdtempSync(path.join(tmpdir(), 'dmg-bg-'))
const render = (scale, file) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W * scale } }).render().asPng()
  writeFileSync(file, png)
  return file
}
const one = render(1, path.join(tmp, 'bg.png'))
const two = render(2, path.join(tmp, 'bg@2x.png'))
const out = path.join(repo, 'desktop', 'build', 'dmg-background.tiff')
execFileSync('tiffutil', ['-cathidpicheck', one, two, '-out', out])
writeFileSync(path.join(repo, 'desktop', 'build', 'dmg-background-preview.png'), new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng())
console.log(`${themeName} app-bg → ${out} (540x380 + 1080x760 retina TIFF)`)
