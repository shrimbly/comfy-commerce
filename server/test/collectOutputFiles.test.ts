import { describe, expect, it } from 'vitest'

import { collectOutputFiles } from '../src/providers/comfyGraph.js'

const ref = (filename: string, type = 'output') => ({ filename, subfolder: '', type })

describe('collectOutputFiles media-type classification', () => {
  it('classifies images, videos, and 3D models by extension', () => {
    const files = collectOutputFiles({
      '1': { images: [ref('out.png')] },
      '2': { videos: [ref('clip.mp4')] },
      '3': { images: [ref('model.glb')] },
    })
    const byName = Object.fromEntries(files.map((f) => [f.filename, f.mediaType]))
    expect(byName['out.png']).toBe('image')
    expect(byName['clip.mp4']).toBe('video')
    expect(byName['model.glb']).toBe('model3d')
  })

  it('treats usdz and gltf as 3D too', () => {
    const files = collectOutputFiles({ '1': { images: [ref('a.usdz'), ref('b.gltf')] } })
    expect(files.every((f) => f.mediaType === 'model3d')).toBe(true)
  })

  it('detects a GLB reported under a non-standard output key', () => {
    // 3D save nodes don't always report under images/videos/gifs — every
    // array-valued field is scanned for file refs.
    const files = collectOutputFiles({ '7': { result: [ref('scene.glb')] } })
    expect(files).toHaveLength(1)
    expect(files[0]!.mediaType).toBe('model3d')
  })

  it('ignores text sinks and other non-file arrays', () => {
    const files = collectOutputFiles({
      '1': { text: ['some caption'] },
      '2': { animated: [true, false] },
      '3': { images: [ref('real.png')] },
    })
    expect(files.map((f) => f.filename)).toEqual(['real.png'])
  })

  it('prefers saved outputs over temp/preview files', () => {
    const files = collectOutputFiles({
      '1': { images: [ref('preview.png', 'temp'), ref('final.png', 'output')] },
    })
    expect(files.map((f) => f.filename)).toEqual(['final.png'])
  })
})
