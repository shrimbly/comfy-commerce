/**
 * Deterministic pastel tone for tag-like chips: saturated text on a soft
 * fill, hashed from the tag name so a tag keeps its color everywhere.
 * Decorative only — status semantics stay with StatusChip.
 */
const TONES = [
  'bg-warn-soft text-warn',
  'bg-success-soft text-success',
  'bg-violet-soft text-violet',
  'bg-info-soft text-info',
  'bg-danger-soft text-danger',
] as const

export function tagTone(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return TONES[hash % TONES.length]!
}
