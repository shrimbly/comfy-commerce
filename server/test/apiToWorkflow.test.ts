import { describe, expect, it } from 'vitest'

import { apiToWorkflow } from '../src/workflows/apiToWorkflow.js'
import type { Graph } from '../src/workflows/parse.js'

const GRAPH: Graph = {
  '1': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '2': { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 768, height: 0 } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'cc' } },
}

describe('apiToWorkflow', () => {
  it('produces a populated editor workflow from an API graph', () => {
    const wf = apiToWorkflow(GRAPH)
    expect(wf.nodes).toHaveLength(3)
    expect(wf.version).toBe(0.4)
  })

  it('keeps literal inputs as widget values and link inputs as sockets', () => {
    const wf = apiToWorkflow(GRAPH)
    const nodes = wf.nodes as Array<{ type: string; inputs: Array<{ name: string }>; widgets_values: unknown[] }>
    const load = nodes.find((n) => n.type === 'LoadImage')!
    expect(load.widgets_values).toEqual(['example.png'])
    expect(load.inputs).toHaveLength(0)
    const scale = nodes.find((n) => n.type === 'ImageScale')!
    expect(scale.inputs.map((s) => s.name)).toEqual(['image'])
    expect(scale.widgets_values).toEqual([768, 0])
  })

  it('reconstructs links between nodes by slot index', () => {
    const wf = apiToWorkflow(GRAPH)
    // [linkId, srcNode, srcSlot, dstNode, dstSlot, type]
    expect(wf.links).toContainEqual([expect.any(Number), 1, 0, 2, 0, 'IMAGE'])
    expect(wf.links).toContainEqual([expect.any(Number), 2, 0, 3, 0, 'IMAGE'])
    expect(wf.last_link_id).toBe(2)
  })
})
