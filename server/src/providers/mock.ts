import { hashSeed } from './comfyGraph.js'
import type {
  CaptionRequest,
  CaptionResult,
  EditRequest,
  EditResult,
  GenerationProvider,
} from './types.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mock provider — instant, deterministic edits rendered by the broker's mock
 * CDN. Built-in workflows encode their recipe + params into the URL; user
 * graphs get a deterministic per-workflow treatment, so before/after is
 * always a genuinely different render.
 */
export class MockProvider implements GenerationProvider {
  id = 'mock' as const
  name = 'Mock engine'
  kind = 'mock' as const
  description = 'Instant simulated edits for testing the pipeline end-to-end.'

  async availability() {
    return { available: true, detail: null }
  }

  async edit(request: EditRequest): Promise<EditResult> {
    // A touch of latency so run progress is observable in the UI.
    await sleep(250 + Math.random() * 500)
    if (request.signal?.aborted) throw new Error('Cancelled')

    const [path, query] = request.imageUrl.split('?')
    const params = new URLSearchParams(query ?? '')

    params.set('recipe', 'workflow')
    params.set('p_wf', request.workflow.workflowKey)

    // Mock edits only apply to mock-CDN images; reduce absolute URLs back to
    // the root-relative form the broker serves.
    const cdnPath = path!.replace(/^https?:\/\/[^/]+/, '')
    if (!cdnPath.startsWith('/mock-cdn/')) {
      throw new Error('The mock engine can only edit demo-store images')
    }
    return { outputs: [{ url: `${cdnPath}?${params.toString()}`, mediaType: 'image' }] }
  }

  async caption(request: CaptionRequest): Promise<CaptionResult> {
    // A touch of latency so enrichment progress is observable in the UI.
    await sleep(150 + Math.random() * 300)
    if (request.signal?.aborted) throw new Error('Cancelled')
    // Deterministic per image: same mediaId → same caption/tags.
    const tones = ['neutral', 'warm', 'cool', 'monochrome']
    const tone = tones[hashSeed(request.seedKey) % tones.length]
    return {
      text: `A clean studio product photo on a plain background.\nTAGS: product, studio, ${tone}, ecommerce`,
    }
  }
}
