import type { Graph } from './parse.js'

/** ComfyUI editor-format workflow — the shape the normal "Load" menu expects. */
export interface EditorWorkflow {
  last_node_id: number
  last_link_id: number
  nodes: unknown[]
  links: unknown[]
  groups: unknown[]
  config: Record<string, unknown>
  extra: Record<string, unknown>
  version: number
}

/** Best-effort socket/link type from an input name (for display + link colour). */
const TYPE_BY_INPUT: Record<string, string> = {
  image: 'IMAGE',
  images: 'IMAGE',
  pixels: 'IMAGE',
  mask: 'MASK',
  model: 'MODEL',
  clip: 'CLIP',
  vae: 'VAE',
  samples: 'LATENT',
  latent: 'LATENT',
  latent_image: 'LATENT',
  positive: 'CONDITIONING',
  negative: 'CONDITIONING',
  conditioning: 'CONDITIONING',
  control_net: 'CONTROL_NET',
}
const typeFor = (name: string): string => TYPE_BY_INPUT[name] ?? '*'

/** An API input value of the form [sourceNodeId, sourceOutputSlot]. */
const isLink = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'

/**
 * Convert an API-format (prompt) graph into a ComfyUI editor workflow, so it
 * drag-drops / Loads into ComfyUI populated instead of showing an empty canvas
 * (which the normal Load menu does with API JSON — it needs "Load (API Format)").
 *
 * Input sockets are restored by name and links by slot index, so connections
 * survive; widget values follow the API input order, which mirrors ComfyUI's
 * definition order. Types are inferred from input names — best-effort but
 * loadable; the user can rewire if a node needs it.
 */
export function apiToWorkflow(graph: Graph): EditorWorkflow {
  const ids = Object.keys(graph)
  // Editor ids must be numeric — reuse integer-looking ids, else assign in order.
  const numId = new Map<string, number>()
  ids.forEach((id, i) => numId.set(id, /^\d+$/.test(id) ? Number(id) : i + 1))

  let linkSeq = 0
  const links: Array<[number, number, number, number, number, string]> = []
  const outBySrc = new Map<string, Map<number, { type: string; links: number[] }>>()
  const inSockets = new Map<string, Array<{ name: string; type: string; link: number }>>()

  for (const id of ids) {
    const sockets: Array<{ name: string; type: string; link: number }> = []
    for (const [key, value] of Object.entries(graph[id]!.inputs)) {
      if (!isLink(value)) continue
      const [srcId, srcSlot] = value
      if (!numId.has(srcId)) continue
      const type = typeFor(key)
      const linkId = ++linkSeq
      links.push([linkId, numId.get(srcId)!, srcSlot, numId.get(id)!, sockets.length, type])
      sockets.push({ name: key, type, link: linkId })
      const slots = outBySrc.get(srcId) ?? new Map()
      const slot = slots.get(srcSlot) ?? { type, links: [] }
      slot.type = type
      slot.links.push(linkId)
      slots.set(srcSlot, slot)
      outBySrc.set(srcId, slots)
    }
    inSockets.set(id, sockets)
  }

  const nodes = ids.map((id, i) => {
    const node = graph[id]!
    const slots = outBySrc.get(id)
    const maxSlot = slots ? Math.max(...slots.keys()) : -1
    return {
      id: numId.get(id)!,
      type: node.class_type,
      ...(node._meta?.title ? { title: node._meta.title } : {}),
      pos: [80 + (i % 4) * 340, 120 + Math.floor(i / 4) * 260 + (i % 4) * 30],
      size: [260, 120],
      flags: {},
      order: i,
      mode: 0,
      inputs: inSockets.get(id) ?? [],
      outputs: Array.from({ length: maxSlot + 1 }, (_, s) => {
        const slot = slots?.get(s)
        return { name: slot?.type ?? '*', type: slot?.type ?? '*', links: slot?.links ?? [], slot_index: s }
      }),
      properties: { 'Node name for S&R': node.class_type },
      widgets_values: Object.values(node.inputs).filter((v) => !isLink(v)),
    }
  })

  return {
    last_node_id: Math.max(0, ...nodes.map((n) => n.id)),
    last_link_id: linkSeq,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  }
}
