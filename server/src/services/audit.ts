import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { auditLog } from '../db/schema.js'

/** Append-only audit trail of who/what touched the review ledger and stores. */
export function createAudit(db: Db) {
  return {
    record(entry: {
      storeId?: string | null
      itemId?: string | null
      action: string
      detail?: Record<string, unknown>
    }): void {
      db.insert(auditLog)
        .values({
          id: randomUUID(),
          ts: new Date().toISOString(),
          storeId: entry.storeId ?? null,
          itemId: entry.itemId ?? null,
          action: entry.action,
          detail: entry.detail ?? {},
        })
        .run()
    },

    list(storeId?: string) {
      const base = db.select().from(auditLog)
      const query = storeId ? base.where(eq(auditLog.storeId, storeId)) : base
      return query.orderBy(desc(auditLog.ts)).limit(200).all()
    },
  }
}

export type Audit = ReturnType<typeof createAudit>
