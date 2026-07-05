import { readFileSync } from 'node:fs'
import { loadEnv } from '../src/env.js'

const env = loadEnv()
const key = env.comfyCloud.apiKey!
const base = env.comfyCloud.apiUrl
const H = { 'X-API-Key': key }

// 1. upload a small input image
const bytes = readFileSync('/tmp/onmodel-1.png')
const form = new FormData()
form.append('image', new Blob([new Uint8Array(bytes)]), 'cc-probe.png')
form.append('type', 'input')
form.append('overwrite', 'true')
const up = await fetch(`${base}/api/upload/image`, { method: 'POST', headers: H, body: form })
const { name } = (await up.json()) as { name: string }
console.log('uploaded:', name)

// 2. submit a trivial model-free graph
const graph = {
  '1': { class_type: 'LoadImage', inputs: { image: name } },
  '2': { class_type: 'ImageScale', inputs: { image: ['1', 0], upscale_method: 'lanczos', width: 256, height: 0, crop: 'disabled' } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'cc-probe' } },
}
const submit = await fetch(`${base}/api/prompt`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: graph }),
})
console.log('submit http:', submit.status)
const submitBody = await submit.json()
console.log('submit body:', JSON.stringify(submitBody).slice(0, 300))
const promptId = (submitBody as { prompt_id: string }).prompt_id

// 3. poll raw status a few times, printing the verbatim response
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const res = await fetch(`${base}/api/job/${promptId}/status`, { headers: H })
  const text = await res.text()
  console.log(`poll ${i} http=${res.status}:`, text.slice(0, 400))
  if (text.includes('completed') || text.includes('success') || text.includes('error')) break
}

// 4. fetch the job document
const job = await fetch(`${base}/api/jobs/${promptId}`, { headers: H })
console.log('job http:', job.status)
console.log('job body:', (await job.text()).slice(0, 800))
