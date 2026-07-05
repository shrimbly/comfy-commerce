import { useEffect } from 'react'

import { useDeletePrompt, usePrompts, useSavePrompt, type SavedPrompt } from '../api/hooks.js'

export type { SavedPrompt }

/** Pre-server prompts lived in localStorage — push them up once, then clear. */
const LEGACY_KEY = 'comfy-commerce.prompt-library'
let migrationStarted = false

function migrateLegacyPrompts(save: (input: { text: string }) => void) {
  if (migrationStarted) return
  migrationStarted = true
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]') as Array<{ text?: string }>
    if (Array.isArray(legacy)) {
      for (const entry of legacy) if (entry.text?.trim()) save({ text: entry.text })
    }
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* unreadable legacy data — nothing to migrate */
  }
}

/**
 * The prompt library — server-backed and shared everywhere: the Prompts
 * page, run-sheet fields, and the large editor all see the same list.
 */
export function usePromptLibrary() {
  const { data: prompts = [] } = usePrompts()
  const create = useSavePrompt()
  const del = useDeletePrompt()

  useEffect(() => migrateLegacyPrompts((input) => create.mutate(input)), [create])

  return {
    prompts,
    save(text: string, name?: string) {
      if (text.trim()) create.mutate({ text, ...(name ? { name } : {}) })
    },
    remove(id: string) {
      del.mutate(id)
    },
  }
}
