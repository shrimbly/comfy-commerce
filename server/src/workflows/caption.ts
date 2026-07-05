/**
 * The built-in catalog-enrichment workflow — an internal, real ComfyUI graph
 * (unlike the recipe-driven img2img built-ins). It captions a product image
 * with a VLM and writes the result to the media_enrichment store; it never
 * stages or publishes anything. The graph itself is built by the providers
 * (see comfyGraph.buildCaptionGraph); these are the run-level parameters.
 */

export { CAPTION_WORKFLOW_ID } from '@comfy-commerce/shared'
export const CAPTION_WORKFLOW_NAME = 'Caption product images'

/**
 * Captioning model — Google Gemini, a Comfy Cloud partner/API node reached via
 * the comfy.org API key (no weights to download, unlike Florence-2; fast and
 * reliable). The graph (comfyGraph.buildCaptionGraph) downscales the image first
 * — Gemini's vision endpoint returns nothing for very large inputs.
 */
export const CAPTION_MODEL = 'gemini-2.5-flash'

/**
 * Instruction handed to the VLM. The goal is SEARCHABILITY, not marketing: a
 * literal, alt-text-style description of what is visually in the frame, plus a
 * broad list of descriptive visual keywords (subject, clothing, colors, objects,
 * setting, lighting, mood, pose). The phrasing is deliberately natural prose —
 * asking Gemini for a rigid "TAGS:"/JSON structure makes it return an empty
 * result, whereas "list … separated by commas" reliably yields
 * "<description>\n<comma-separated keywords>", which parseCaption splits.
 */
export const CAPTION_PROMPT =
  'Describe what is literally visible in this image in one plain sentence, like alt ' +
  'text for image search: the subject, what they are doing, what they are wearing ' +
  'and its colors, the setting, and the lighting. Then, in a second sentence, list ' +
  'many descriptive search keywords for the visible elements (people, clothing, ' +
  'colors, objects, setting, lighting, mood, pose), as lowercase words and short ' +
  'phrases separated by commas.'

const cleanTags = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase().replace(/\.+$/, ''))
      .filter((t) => t.length > 0 && t.length <= 40),
  ),
]

/**
 * Split a VLM response into a caption and discrete search tags. Handles two
 * shapes: an explicit "<sentence>\nTAGS: a, b, c" marker (the mock engine /
 * legacy), and the markerless "<description>\n<comma-separated keywords>" Gemini
 * returns — where the comma-rich line is the keyword list. Degrades gracefully:
 * with neither, the whole text is the caption and tags are empty.
 */
export function parseCaption(text: string): { caption: string; tags: string[] } {
  const trimmed = text.trim()

  // Explicit TAGS: marker.
  const markerIdx = trimmed.search(/\n?\s*tags?\s*:/i)
  if (markerIdx !== -1) {
    return {
      caption: trimmed.slice(0, markerIdx).trim(),
      tags: cleanTags(trimmed.slice(markerIdx).replace(/^\n?\s*tags?\s*:/i, '')),
    }
  }

  // Markerless: the comma-richest line is the keyword list (require >2 commas so
  // a stray comma in prose isn't mistaken for tags).
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  let tagLine = -1
  let maxCommas = 2
  for (let i = 0; i < lines.length; i++) {
    const commas = (lines[i]!.match(/,/g) ?? []).length
    if (commas > maxCommas) {
      maxCommas = commas
      tagLine = i
    }
  }
  if (tagLine === -1) return { caption: trimmed, tags: [] }
  const caption = lines.filter((_, i) => i !== tagLine).join(' ').trim()
  return { caption: caption || trimmed, tags: cleanTags(lines[tagLine]!) }
}
