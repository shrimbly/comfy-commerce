import { useState } from 'react'

import type { IconAnimState } from './animated-icons/shared.js'

/**
 * Track hover on an element to drive an animated icon. Spread `props` on the
 * hover target (e.g. a Button) and pass `state` to the icon's `animate`, the
 * same rest/hover contract the sidebar nav rows use.
 */
export function useHover() {
  const [hovered, setHovered] = useState(false)
  const state: IconAnimState = hovered ? 'hover' : 'rest'
  return {
    state,
    props: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
  }
}
