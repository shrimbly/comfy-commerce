import { describe, expect, it } from 'vitest'

import {
  convertEditorGraph,
  extractAppMode,
  isEditorFormat,
  type EditorFile,
  type ObjectInfo,
} from '../src/workflows/editor.js'

const OBJECT_INFO: ObjectInfo = {
  LoadImage: { input: { required: { image: [['a.png', 'b.png'], { image_upload: true }] } } },
  ImageScale: {
    input: {
      required: {
        image: ['IMAGE', {}],
        upscale_method: [['nearest-exact', 'lanczos'], {}],
        width: ['INT', { default: 512 }],
        height: ['INT', { default: 512 }],
        crop: [['disabled', 'center'], {}],
      },
    },
  },
  BasicScheduler: {
    input: {
      required: {
        model: ['MODEL', {}],
        // Newer schema form: type is the literal string 'COMBO'.
        scheduler: ['COMBO', { options: ['simple', 'normal', 'karras'] }],
        steps: ['INT', { default: 20 }],
        denoise: ['FLOAT', { default: 1 }],
      },
    },
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL', {}],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        positive: ['CONDITIONING', {}],
        latent_image: ['LATENT', {}],
      },
    },
  },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
}

function editorFile(overrides: Partial<EditorFile> = {}): EditorFile {
  return {
    nodes: [
      { id: 1, type: 'LoadImage', title: 'Product photo', widgets_values: ['tee.png', 'image'] },
      {
        id: 2,
        type: 'ImageScale',
        inputs: [{ name: 'image', link: 10 }],
        widgets_values: ['lanczos', 768, 0, 'disabled'],
      },
      {
        id: 3,
        type: 'SaveImage',
        inputs: [{ name: 'images', link: 11 }],
        widgets_values: ['out'],
      },
      { id: 9, type: 'Note', widgets_values: ['remember to feed the cat'] },
    ],
    links: [
      [10, 1, 0, 2, 0, 'IMAGE'],
      [11, 2, 0, 3, 0, 'IMAGE'],
    ],
    ...overrides,
  }
}

describe('editor-format conversion', () => {
  it('detects editor format', () => {
    expect(isEditorFormat(editorFile())).toBe(true)
    expect(isEditorFormat({ '1': { class_type: 'LoadImage', inputs: {} } })).toBe(false)
  })

  it('converts nodes, widget values, and links', () => {
    const graph = convertEditorGraph(editorFile(), OBJECT_INFO)
    expect(Object.keys(graph).sort()).toEqual(['1', '2', '3'])
    expect(graph['1']).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'tee.png' } })
    expect(graph['2']!.inputs).toEqual({
      image: ['1', 0],
      upscale_method: 'lanczos',
      width: 768,
      height: 0,
      crop: 'disabled',
    })
    expect(graph['3']!.inputs).toEqual({ images: ['2', 0], filename_prefix: 'out' })
    expect(graph['1']!._meta?.title).toBe('Product photo')
  })

  it('skips the seed control companion value', () => {
    const file = editorFile({
      nodes: [
        {
          id: 5,
          type: 'KSampler',
          inputs: [
            { name: 'model', link: 20 },
            { name: 'positive', link: 21 },
            { name: 'latent_image', link: 22 },
          ],
          widgets_values: [42, 'randomize', 20, 7.5],
        },
      ],
      links: [],
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(graph['5']!.inputs).toMatchObject({ seed: 42, steps: 20, cfg: 7.5 })
  })

  it("maps widgets for the newer 'COMBO' string spec form", () => {
    const file = editorFile({
      nodes: [
        {
          id: 112,
          type: 'BasicScheduler',
          inputs: [{ name: 'model', link: 30 }],
          widgets_values: ['normal', 28, 1],
        },
      ],
      links: [],
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(graph['112']!.inputs).toMatchObject({ scheduler: 'normal', steps: 28, denoise: 1 })
  })

  it('expands V3 dynamic combos with dotted names; autogrow slots stay link-only', () => {
    const info: ObjectInfo = {
      ...OBJECT_INFO,
      GeminiNanoBanana2V2: {
        input: {
          required: {
            prompt: ['STRING', { multiline: true }],
            model: [
              'COMFY_DYNAMICCOMBO_V3',
              {
                options: [
                  {
                    key: 'Nano Banana 2',
                    inputs: {
                      required: {
                        aspect_ratio: ['COMBO', { options: ['auto', '1:1'] }],
                        resolution: ['COMBO', { options: ['1K', '2K'] }],
                        images: [
                          'COMFY_AUTOGROW_V3',
                          { template: { input: { required: { image: ['IMAGE', {}] } } } },
                        ],
                      },
                      optional: { files: ['GEMINI_INPUT_FILES', {}] },
                    },
                  },
                ],
              },
            ],
            seed: ['INT', { control_after_generate: true }],
            system_prompt: ['STRING', {}],
          },
        },
      },
    }
    const file = editorFile({
      nodes: [
        { id: 16, type: 'LoadImage', widgets_values: ['dog.png', 'image'] },
        {
          id: 24,
          type: 'GeminiNanoBanana2V2',
          inputs: [
            { name: 'model.images.image_1', type: 'IMAGE', link: 22 },
            { name: 'model.images.image_2', type: 'IMAGE', link: null },
            { name: 'model.files', type: 'GEMINI_INPUT_FILES', link: null },
          ],
          widgets_values: ['make it beachy', 'Nano Banana 2', 'auto', '1K', 7, 'randomize', 'sys'],
        },
      ],
      links: [[22, 16, 0, 24, 0, 'IMAGE']],
    })
    const graph = convertEditorGraph(file, info)
    expect(graph['24']!.inputs).toEqual({
      prompt: 'make it beachy',
      model: 'Nano Banana 2',
      'model.aspect_ratio': 'auto',
      'model.resolution': '1K',
      seed: 7,
      system_prompt: 'sys',
      'model.images.image_1': ['16', 0],
    })
  })

  it('maps every CustomCombo option from widgets_values (dynamic, schema-light)', () => {
    // No CustomCombo entry in OBJECT_INFO on purpose: the dropdown must still
    // convert (and surface during inspection) even when no engine declares it.
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        {
          id: 5,
          type: 'CustomCombo',
          title: 'Lighting Style',
          widgets_values: ['Rembrandt', 0, 'Soft Studio', 'Clamshell', 'Rembrandt', ''],
        },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 11 }], widgets_values: ['out'] },
      ],
      links: [[11, 1, 0, 3, 0, 'IMAGE']],
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(graph['5']!.inputs).toEqual({
      choice: 'Rembrandt',
      index: 0,
      option1: 'Soft Studio',
      option2: 'Clamshell',
      option3: 'Rembrandt', // trailing '' slot skipped
    })
  })

  it('routes through bypassed (mode 4) nodes', () => {
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        {
          id: 7,
          type: 'ImageScale',
          mode: 4,
          inputs: [{ name: 'image', type: 'IMAGE', link: 10 }],
          outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
          widgets_values: ['lanczos', 512, 0, 'disabled'],
        },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 12 }], widgets_values: ['out'] },
      ],
      links: [
        [10, 1, 0, 7, 0, 'IMAGE'],
        [12, 7, 0, 3, 0, 'IMAGE'],
      ],
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(graph['7']).toBeUndefined()
    expect(graph['3']!.inputs.images).toEqual(['1', 0])
  })

  it('resolves links through reroutes', () => {
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        { id: 7, type: 'Reroute', inputs: [{ name: '', link: 10 }] },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 12 }], widgets_values: ['out'] },
      ],
      links: [
        [10, 1, 0, 7, 0, 'IMAGE'],
        [12, 7, 0, 3, 0, 'IMAGE'],
      ],
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(graph['3']!.inputs.images).toEqual(['1', 0])
    expect(graph['7']).toBeUndefined()
  })

  it('flattens subgraphs with namespaced ids and boundary rewiring', () => {
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        {
          id: 50,
          type: 'sub-guid-1',
          inputs: [
            { name: 'image', link: 100 },
            { name: 'width', link: null, widget: { name: 'width' } },
          ],
          widgets_values: [640],
        },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 101 }], widgets_values: ['out'] },
      ],
      links: [
        [100, 1, 0, 50, 0, 'IMAGE'],
        [101, 50, 0, 3, 0, 'IMAGE'],
      ],
      definitions: {
        subgraphs: [
          {
            id: 'sub-guid-1',
            name: 'Resize',
            nodes: [
              {
                id: 9,
                type: 'ImageScale',
                inputs: [
                  { name: 'image', link: 200 },
                  { name: 'width', link: 201, widget: { name: 'width' } },
                ],
                widgets_values: ['lanczos', 512, 0, 'disabled'],
              },
            ],
            links: [
              { id: 200, origin_id: -10, origin_slot: 0, target_id: 9, target_slot: 0 },
              { id: 201, origin_id: -10, origin_slot: 1, target_id: 9, target_slot: 1 },
              { id: 210, origin_id: 9, origin_slot: 0, target_id: -20, target_slot: 0 },
            ],
            inputs: [
              { name: 'image', type: 'IMAGE', linkIds: [200] },
              { name: 'width', type: 'INT', linkIds: [201] },
            ],
            outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [210] }],
          },
        ],
      },
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(Object.keys(graph).sort()).toEqual(['1', '3', '50:9'])
    // boundary input: outer LoadImage feeds the inner node
    expect(graph['50:9']!.inputs.image).toEqual(['1', 0])
    // promoted widget on the instance overrides the inner default
    expect(graph['50:9']!.inputs.width).toBe(640)
    // boundary output: outer consumer rewired to the inner source
    expect(graph['3']!.inputs.images).toEqual(['50:9', 0])
  })

  it('matches boundary inputs by name when an instance materializes a subset', () => {
    // Def declares [text, width, image]; the instance only shows [text, image].
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        {
          id: 50,
          type: 'sub-guid-1',
          inputs: [
            { name: 'text', type: 'STRING', link: null, widget: { name: 'text' } },
            { name: 'image', type: 'IMAGE', link: 100 },
          ],
          widgets_values: ['hello'],
        },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 101 }], widgets_values: ['out'] },
      ],
      links: [
        [100, 1, 0, 50, 1, 'IMAGE'],
        [101, 50, 0, 3, 0, 'IMAGE'],
      ],
      definitions: {
        subgraphs: [
          {
            id: 'sub-guid-1',
            nodes: [
              {
                id: 9,
                type: 'ImageScale',
                inputs: [
                  { name: 'image', link: 202 },
                  { name: 'width', link: 201, widget: { name: 'width' } },
                ],
                widgets_values: ['lanczos', 512, 0, 'disabled'],
              },
            ],
            links: [
              { id: 200, origin_id: -10, origin_slot: 0, target_id: 99, target_slot: 0 },
              { id: 201, origin_id: -10, origin_slot: 1, target_id: 9, target_slot: 1 },
              { id: 202, origin_id: -10, origin_slot: 2, target_id: 9, target_slot: 0 },
              { id: 210, origin_id: 9, origin_slot: 0, target_id: -20, target_slot: 0 },
            ],
            inputs: [
              { name: 'text', type: 'STRING', linkIds: [200] },
              { name: 'width', type: 'INT', linkIds: [201] },
              { name: 'image', type: 'IMAGE', linkIds: [202] },
            ],
            outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [210] }],
          },
        ],
      },
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    // width boundary (slot 1) is NOT on the instance — must keep the inner
    // default, not steal the instance's slot-1 input (the image).
    expect(graph['50:9']!.inputs.width).toBe(512)
    expect(graph['50:9']!.inputs.image).toEqual(['1', 0])
  })

  it('keeps inner defaults for unconnected boundary inputs', () => {
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        {
          id: 50,
          type: 'sub-guid-1',
          inputs: [{ name: 'image', link: 100 }],
          widgets_values: [],
        },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 101 }], widgets_values: ['out'] },
      ],
      links: [
        [100, 1, 0, 50, 0, 'IMAGE'],
        [101, 50, 0, 3, 0, 'IMAGE'],
      ],
      definitions: {
        subgraphs: [
          {
            id: 'sub-guid-1',
            nodes: [
              {
                id: 9,
                type: 'ImageScale',
                inputs: [{ name: 'image', link: 200 }],
                widgets_values: ['lanczos', 512, 0, 'disabled'],
              },
            ],
            links: [
              { id: 200, origin_id: -10, origin_slot: 0, target_id: 9, target_slot: 0 },
              { id: 210, origin_id: 9, origin_slot: 0, target_id: -20, target_slot: 0 },
            ],
            inputs: [{ name: 'image', type: 'IMAGE', linkIds: [200] }],
            outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [210] }],
          },
        ],
      },
    })
    const graph = convertEditorGraph(file, OBJECT_INFO)
    expect(graph['50:9']!.inputs.width).toBe(512) // inner default preserved
  })

  it('rejects nodes missing from the engine catalog', () => {
    const file = editorFile({
      nodes: [{ id: 1, type: 'TotallyCustomNode', widgets_values: ['x'] }],
      links: [],
    })
    expect(() => convertEditorGraph(file, OBJECT_INFO)).toThrow(/TotallyCustomNode/)
  })

  it('carries custom widget values (curve editors) and fills omitted required widgets', () => {
    // CURVE is never produced as an output → a widget, not a connection.
    // ImageCompare.compare_view is required but the save omits it.
    const info: ObjectInfo = {
      ...OBJECT_INFO,
      CurveEditor: {
        input: { required: { curve: ['CURVE', {}], histogram: ['IMAGE', {}] } },
      },
      ImageCompare: {
        input: {
          required: {
            image_a: ['IMAGE', {}],
            image_b: ['IMAGE', {}],
            compare_view: [['Side-by-side', 'Slider'], {}],
          },
        },
      },
    }
    const curve = { points: [[0, 0], [1, 1]], interpolation: 'monotone_cubic' }
    const file = editorFile({
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['tee.png', 'image'] },
        { id: 4, type: 'CurveEditor', inputs: [{ name: 'histogram', link: 40 }], widgets_values: [curve] },
        {
          id: 13,
          type: 'ImageCompare',
          inputs: [
            { name: 'image_a', link: 41 },
            { name: 'image_b', link: 42 },
          ],
          widgets_values: [],
        },
        { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 11 }], widgets_values: ['out'] },
      ],
      links: [
        [40, 1, 0, 4, 0, 'IMAGE'],
        [41, 4, 0, 13, 0, 'IMAGE'],
        [42, 1, 0, 13, 1, 'IMAGE'],
        [11, 4, 0, 3, 0, 'IMAGE'],
      ],
    })
    const graph = convertEditorGraph(file, info)
    // the object-valued curve widget is carried through, not dropped
    expect(graph['4']!.inputs.curve).toEqual(curve)
    expect(graph['4']!.inputs.histogram).toEqual(['1', 0])
    // the required widget the save omitted is filled with the engine default
    expect(graph['13']!.inputs).toEqual({
      image_a: ['4', 0],
      image_b: ['1', 0],
      compare_view: 'Side-by-side',
    })
  })
})

describe('real-world template (Qwen Image Edit 2509, 2 subgraph defs)', () => {
  it('flattens to a closed graph with namespaced ids', async () => {
    const { readFileSync } = await import('node:fs')
    const file = JSON.parse(
      readFileSync(new URL('./fixtures/qwen-edit-template.json', import.meta.url), 'utf8'),
    ) as EditorFile
    const objectInfo = JSON.parse(
      readFileSync(new URL('./fixtures/object-info-subset.json', import.meta.url), 'utf8'),
    ) as ObjectInfo

    const graph = convertEditorGraph(file, objectInfo)
    expect(Object.keys(graph).length).toBeGreaterThanOrEqual(20)
    // ComfyUI's own namespacing convention for flattened subgraph nodes.
    expect(Object.keys(graph).some((k) => k.includes(':'))).toBe(true)

    // Closure: every link tuple references an emitted node.
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && typeof value[0] === 'string') {
          expect(graph[value[0]], `dangling ref → ${value[0]}`).toBeDefined()
        }
      }
    }

    // The sampler lives inside a subgraph, fully wired across the boundary.
    const ksampler = Object.entries(graph).find(([, n]) => n.class_type === 'KSampler')
    expect(ksampler).toBeDefined()
    expect(ksampler![0]).toContain(':')
    expect(typeof ksampler![1].inputs.seed).toBe('number')
    expect(Array.isArray(ksampler![1].inputs.model)).toBe(true)
  })
})

describe('App Mode extraction', () => {
  it('reads linearData and drops dangling node references', () => {
    const file = editorFile({
      extra: {
        linearMode: true,
        linearData: {
          inputs: [
            ['590', 'choice'], // dangling — node deleted
            [1, 'image', { height: 98 }],
            [2, 'width'],
          ],
          outputs: [3],
        },
      },
    })
    const appMode = extractAppMode(file)
    expect(appMode).toEqual({
      inputs: [
        { nodeId: '1', widget: 'image' },
        { nodeId: '2', widget: 'width' },
      ],
      outputNodeId: '3',
    })
  })

  it('treats linearData as App Mode when the linearMode flag is absent', () => {
    // Newer ComfyUI exports omit the linearMode flag but still carry the
    // author's curated linearData — honour it.
    const file = editorFile({
      extra: { linearData: { inputs: [[1, 'image'], [2, 'width']], outputs: [3] } },
    })
    expect(extractAppMode(file)).toEqual({
      inputs: [
        { nodeId: '1', widget: 'image' },
        { nodeId: '2', widget: 'width' },
      ],
      outputNodeId: '3',
    })
  })

  it('respects an explicit linearMode: false', () => {
    const file = editorFile({
      extra: { linearMode: false, linearData: { inputs: [[1, 'image']], outputs: [3] } },
    })
    expect(extractAppMode(file)).toBeNull()
  })

  it('returns null when there are no curated inputs', () => {
    expect(extractAppMode(editorFile())).toBeNull()
  })
})
