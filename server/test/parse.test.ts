import { describe, expect, it } from 'vitest'

import { inspectGraph, parseGraph, patchGraph } from '../src/workflows/parse.js'

const SIMPLE_GRAPH = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '3': { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a product photo', clip: ['1', 1] },
    _meta: { title: 'Positive prompt' },
  },
  '6': {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], positive: ['4', 0], latent_image: ['3', 0], seed: 42, denoise: 0.5 },
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'out' } },
}

describe('workflow graph parsing', () => {
  it('rejects non-API-format payloads', () => {
    expect(() => parseGraph({ nodes: [], links: [] })).toThrow(/Export \(API\)/)
    expect(() => parseGraph('not json at all')).toThrow()
  })

  it('accepts a {prompt: ...} wrapper', () => {
    const graph = parseGraph({ prompt: SIMPLE_GRAPH })
    expect(Object.keys(graph)).toHaveLength(6)
  })

  it('auto-binds a single LoadImage and prefers SaveImage outputs', () => {
    const inspection = inspectGraph(parseGraph(SIMPLE_GRAPH))
    expect(inspection.autoBinding).toEqual({ inputNodeId: '2', outputNodeId: '9' })
    expect(inspection.nodeCount).toBe(6)
  })

  it('reports ambiguity with two image inputs', () => {
    const twoInputs = {
      ...SIMPLE_GRAPH,
      '20': { class_type: 'LoadImage', inputs: { image: 'mask-source.png' } },
    }
    const inspection = inspectGraph(parseGraph(twoInputs))
    expect(inspection.autoBinding).toBeNull()
    expect(inspection.inputCandidates).toHaveLength(2)
  })

  it('surfaces literal inputs as param candidates with node titles', () => {
    const inspection = inspectGraph(parseGraph(SIMPLE_GRAPH))
    const prompt = inspection.paramCandidates.find((p) => p.nodeId === '4')
    expect(prompt).toMatchObject({ inputKey: 'text', valueType: 'text' })
    expect(prompt!.label).toContain('Positive prompt')
    // linked inputs (e.g. KSampler.model) are not candidates
    expect(inspection.paramCandidates.some((p) => p.inputKey === 'model')).toBe(false)
  })

  it('exposes a CustomCombo as a select param with its options', () => {
    const graph = parseGraph({
      '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      '2': {
        class_type: 'CustomCombo',
        inputs: { choice: 'B', index: 1, option1: 'A', option2: 'B', option3: 'C', option4: '' },
        _meta: { title: 'Style' },
      },
      '9': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'o' } },
    })
    const inspection = inspectGraph(graph)
    const choice = inspection.paramCandidates.find((p) => p.nodeId === '2' && p.inputKey === 'choice')
    expect(choice).toMatchObject({
      valueType: 'select',
      currentValue: 'B',
      options: [
        { value: 'A', label: 'A' },
        { value: 'B', label: 'B' },
        { value: 'C', label: 'C' },
      ],
    })
    // The option list and numeric index are folded into `choice`, not separate params.
    expect(inspection.paramCandidates.some((p) => /^option\d+$/.test(p.inputKey))).toBe(false)
    expect(inspection.paramCandidates.some((p) => p.nodeId === '2' && p.inputKey === 'index')).toBe(false)
  })

  it('re-derives a CustomCombo index from the selected choice', () => {
    const graph = parseGraph({
      '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      '2': {
        class_type: 'CustomCombo',
        inputs: { choice: 'A', index: 0, option1: 'A', option2: 'B', option3: 'Low-Key' },
      },
      '9': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'o' } },
    })
    const patched = patchGraph(graph, {
      images: [{ nodeId: '1', imageName: 'p.png' }],
      outputNodeId: '9',
      assignments: [{ nodeId: '2', inputKey: 'choice', value: 'Low-Key' }],
      seed: 1,
    })
    // index follows the chosen label's position, not the saved value (0)
    expect(patched['2']!.inputs.choice).toBe('Low-Key')
    expect(patched['2']!.inputs.index).toBe(2)
  })

  it('patches image, params and seed without mutating the original', () => {
    const graph = parseGraph(SIMPLE_GRAPH)
    const patched = patchGraph(graph, {
      images: [{ nodeId: '2', imageName: 'uploaded.png' }],
      outputNodeId: '9',
      assignments: [{ nodeId: '4', inputKey: 'text', value: 'new prompt' }],
      seed: 1234,
    })
    expect(patched['2']!.inputs.image).toBe('uploaded.png')
    expect(patched['4']!.inputs.text).toBe('new prompt')
    expect(patched['6']!.inputs.seed).toBe(1234)
    expect(graph['2']!.inputs.image).toBe('example.png') // untouched
  })

  it('randomises every seed input — seed, *_seed, and dotted combo seeds', () => {
    // The Tripo P1 node pins its seeds under non-`seed` names; matching only a
    // literal `seed` left them fixed, so the node returned an identical model.
    const graph = parseGraph({
      '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      '2': {
        class_type: 'TripoP1ImageToModelNode',
        inputs: {
          image: ['1', 0],
          model_seed: 42,
          'output_mode.texture_seed': 42,
          face_limit: -1,
        },
      },
      '6': { class_type: 'KSampler', inputs: { latent_image: ['1', 0], seed: 42, denoise: 0.5 } },
      '9': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'o' } },
    })
    const patched = patchGraph(graph, {
      images: [{ nodeId: '1', imageName: 'p.png' }],
      outputNodeId: '9',
      assignments: [],
      seed: 5555,
    })
    expect(patched['6']!.inputs.seed).toBe(5555)
    expect(patched['2']!.inputs.model_seed).toBe(5555)
    expect(patched['2']!.inputs['output_mode.texture_seed']).toBe(5555)
    // non-seed numeric inputs are left alone
    expect(patched['2']!.inputs.face_limit).toBe(-1)
  })

  it('binds several image inputs — a product plus fixed reference images', () => {
    const twoInputs = {
      ...SIMPLE_GRAPH,
      '20': { class_type: 'LoadImage', inputs: { image: 'model-ref.png' } },
    }
    const patched = patchGraph(parseGraph(twoInputs), {
      images: [
        { nodeId: '2', imageName: 'product.png' },
        { nodeId: '20', imageName: 'fixed-model.png' },
      ],
      outputNodeId: '9',
      assignments: [],
      seed: 7,
    })
    expect(patched['2']!.inputs.image).toBe('product.png')
    expect(patched['20']!.inputs.image).toBe('fixed-model.png')
  })

  it('throws when a bound image node is missing from the graph', () => {
    expect(() =>
      patchGraph(parseGraph(SIMPLE_GRAPH), {
        images: [{ nodeId: '999', imageName: 'nope.png' }],
        outputNodeId: '9',
        assignments: [],
        seed: 1,
      }),
    ).toThrow(/missing from graph/)
  })

  it('converts a PreviewImage output to SaveImage when bound', () => {
    const preview = {
      ...SIMPLE_GRAPH,
      '9': { class_type: 'PreviewImage', inputs: { images: ['6', 0] } },
    }
    const patched = patchGraph(parseGraph(preview), {
      images: [{ nodeId: '2', imageName: 'x.png' }],
      outputNodeId: '9',
      assignments: [],
      seed: 1,
    })
    expect(patched['9']!.class_type).toBe('SaveImage')
    expect(patched['9']!.inputs.filename_prefix).toBe('comfy-commerce')
  })
})
