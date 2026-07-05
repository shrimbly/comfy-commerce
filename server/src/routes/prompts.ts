import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppContext } from '../context.js'
import { prompts } from '../db/schema.js'

/** CRUD for the reusable prompt library. */
export function registerPromptRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx

  app.get('/api/prompts', async () => ({
    prompts: db.select().from(prompts).orderBy(desc(prompts.updatedAt)).all(),
  }))

  app.post('/api/prompts', async (request, reply) => {
    const body = z
      .object({ name: z.string().optional(), text: z.string().min(1) })
      .parse(request.body)
    const text = body.text.trim()
    const now = new Date().toISOString()
    // Saving identical text again just bumps it — the library stays deduped.
    const existing = db.select().from(prompts).where(eq(prompts.text, text)).get()
    if (existing) {
      const name = body.name?.trim() || existing.name
      db.update(prompts).set({ updatedAt: now, name }).where(eq(prompts.id, existing.id)).run()
      return { prompt: { ...existing, name, updatedAt: now } }
    }
    const row = { id: randomUUID(), name: body.name?.trim() ?? '', text, createdAt: now, updatedAt: now }
    db.insert(prompts).values(row).run()
    return reply.status(201).send({ prompt: row })
  })

  app.patch('/api/prompts/:id', async (request) => {
    const { id } = request.params as { id: string }
    const body = z
      .object({ name: z.string().optional(), text: z.string().min(1).optional() })
      .parse(request.body)
    const existing = db.select().from(prompts).where(eq(prompts.id, id)).get()
    if (!existing) throw Object.assign(new Error('Prompt not found'), { statusCode: 404 })
    const updated = {
      ...existing,
      name: body.name !== undefined ? body.name.trim() : existing.name,
      text: body.text !== undefined ? body.text.trim() : existing.text,
      updatedAt: new Date().toISOString(),
    }
    db.update(prompts)
      .set({ name: updated.name, text: updated.text, updatedAt: updated.updatedAt })
      .where(eq(prompts.id, id))
      .run()
    return { prompt: updated }
  })

  app.delete('/api/prompts/:id', async (request) => {
    const { id } = request.params as { id: string }
    db.delete(prompts).where(eq(prompts.id, id)).run()
    return { ok: true }
  })
}
