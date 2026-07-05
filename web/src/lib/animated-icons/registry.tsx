import type { FC } from 'react'

import { ActivityIcon } from './ActivityIcon.js'
import { BrowseIcon } from './BrowseIcon.js'
import { ConnectorsIcon } from './ConnectorsIcon.js'
import { PromptsIcon } from './PromptsIcon.js'
import { ReviewIcon } from './ReviewIcon.js'
import { WorkflowsIcon } from './WorkflowsIcon.js'
import type { AnimatedIconProps } from './shared.js'

export interface AnimatedIconDef {
  /** Stable key — matches the sidebar nav route (path without the leading slash). */
  key: string
  label: string
  Icon: FC<AnimatedIconProps>
}

/** Every animated icon, in display order. Add an entry here as each is built. */
export const ANIMATED_ICONS: AnimatedIconDef[] = [
  { key: 'connectors', label: 'Connectors', Icon: ConnectorsIcon },
  { key: 'workflows', label: 'Workflows', Icon: WorkflowsIcon },
  { key: 'prompts', label: 'Prompts', Icon: PromptsIcon },
  { key: 'browse', label: 'Browse products', Icon: BrowseIcon },
  { key: 'review', label: 'Review & publish', Icon: ReviewIcon },
  { key: 'activity', label: 'Activity', Icon: ActivityIcon },
]

const BY_KEY = new Map(ANIMATED_ICONS.map((def) => [def.key, def.Icon]))

/** The animated icon for a nav key, or null if it isn't animated yet. */
export function animatedIcon(key: string): FC<AnimatedIconProps> | null {
  return BY_KEY.get(key) ?? null
}
